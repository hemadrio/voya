/**
 * API Gateway — Stripe webhook raw-body passthrough test (WO-046, AC7).
 *
 * Verifies that the gateway proxies POST /webhooks/stripe without:
 *   - JSON-parsing the body (req.body must be a Buffer)
 *   - Stripping or modifying the stripe-signature header
 *   - Re-encoding or mutating the byte stream
 *
 * This is asserted by injecting a custom webhookHandler into createApp()
 * that captures the request state before responding.  Production wires the
 * real downstream proxy here; tests inject a capturer.
 *
 * AC7 requirement: "The API gateway route for the webhook path proxies the
 * request untransformed: no JSON parsing, no re-encoding, no header stripping
 * of stripe-signature; asserted by an end-to-end test through the gateway."
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { TEST_KEY_CURRENT } from './fixtures/testKeys.js';

// ---------------------------------------------------------------------------
// Minimal stubs for required GatewayOptions
// ---------------------------------------------------------------------------

function makeGatewayOptions() {
  const keyProvider = {
    getKeys: vi.fn(async () => [
      { publicKey: TEST_KEY_CURRENT.publicKeyPem, version: TEST_KEY_CURRENT.version },
    ]),
  };
  const denylist = { isRevoked: vi.fn(async () => false) };
  return { keyProvider, denylist, nodeEnv: 'test' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'whsec_SYNTH0000000000000000000000001';

function makeStripeSignature(body: string): string {
  const now = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', TEST_SECRET).update(`${now}.${body}`, 'utf8').digest('hex');
  return `t=${now},v1=${sig}`;
}

// ---------------------------------------------------------------------------
// AC7: raw body preserved, header not stripped
// ---------------------------------------------------------------------------

describe('POST /webhooks/stripe — raw body passthrough through gateway (AC7)', () => {
  it('delivers req.body as a Buffer to the webhook handler (not parsed JSON)', async () => {
    let capturedBody: unknown = null;

    const app = createApp({
      ...makeGatewayOptions(),
      webhookHandler: (req, res) => {
        capturedBody = req.body;
        res.status(200).json({ received: true });
      },
    });

    const payload = JSON.stringify({
      id: 'SYNTH-EVT-0001',
      type: 'payment_intent.succeeded',
    });
    const sig = makeStripeSignature(payload);

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);
    // AC7: body must arrive as a Buffer — not a parsed JS object
    expect(capturedBody).toBeInstanceOf(Buffer);
  });

  it('body Buffer is byte-identical to the transmitted payload', async () => {
    let capturedBody: unknown = null;

    const app = createApp({
      ...makeGatewayOptions(),
      webhookHandler: (req, res) => {
        capturedBody = req.body;
        res.status(200).json({ received: true });
      },
    });

    // Payload with unicode and special characters to verify byte-identical forwarding
    const payload = '{"type":"payment_intent.succeeded","special":"💰 unicode \\u0000 null byte"}';
    const sig = makeStripeSignature(payload);

    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sig)
      .send(payload);

    expect(capturedBody).toBeInstanceOf(Buffer);
    // Byte-for-byte identical: stringified Buffer equals the original payload
    expect((capturedBody as Buffer).toString('utf8')).toBe(payload);
  });

  it('stripe-signature header is forwarded to the webhook handler unchanged', async () => {
    let capturedSig: string | undefined = undefined;

    const app = createApp({
      ...makeGatewayOptions(),
      webhookHandler: (req, res) => {
        const rawSig = req.headers['stripe-signature'];
        capturedSig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
        res.status(200).json({ received: true });
      },
    });

    const payload = JSON.stringify({ id: 'SYNTH-EVT-0002', type: 'charge.refunded' });
    const sig = makeStripeSignature(payload);

    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sig)
      .send(payload);

    // AC7: header must not be stripped by the gateway
    expect(capturedSig).toBe(sig);
  });

  it('global JSON parser does NOT affect the webhook path (body is not a parsed object)', async () => {
    let capturedBodyType: string | null = null;

    const app = createApp({
      ...makeGatewayOptions(),
      webhookHandler: (req, res) => {
        // A parsed JSON body would be a plain object; raw would be a Buffer
        capturedBodyType = Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body;
        res.status(200).json({ received: true });
      },
    });

    const payload = JSON.stringify({ type: 'payment_intent.succeeded', id: 'SYNTH-EVT-0003' });
    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', makeStripeSignature(payload))
      .send(payload);

    // Must be 'Buffer', not 'object' (which would mean JSON parsing occurred)
    expect(capturedBodyType).toBe('Buffer');
  });

  it('HMAC computed over the captured Buffer succeeds — proves byte-identical forwarding', async () => {
    const capturedArgs: { body: Buffer; sig: string }[] = [];

    const app = createApp({
      ...makeGatewayOptions(),
      webhookHandler: (req, res) => {
        const rawSig = req.headers['stripe-signature'];
        const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
        capturedArgs.push({ body: req.body as Buffer, sig: sig ?? '' });
        res.status(200).json({ received: true });
      },
    });

    const payload = JSON.stringify({ type: 'payment_intent.succeeded', id: 'SYNTH-EVT-HMAC' });
    const now = Math.floor(Date.now() / 1000);
    const expectedSig = createHmac('sha256', TEST_SECRET)
      .update(`${now}.${payload}`, 'utf8')
      .digest('hex');
    const sig = `t=${now},v1=${expectedSig}`;

    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sig)
      .send(payload);

    expect(capturedArgs).toHaveLength(1);
    const { body, sig: capturedSig } = capturedArgs[0]!;

    // Re-derive HMAC from the captured Buffer using the same secret
    const parts = capturedSig.split(',');
    const tPart = parts.find((p) => p.startsWith('t='));
    const v1Part = parts.find((p) => p.startsWith('v1='));
    expect(tPart).toBeDefined();
    expect(v1Part).toBeDefined();

    const ts = tPart!.slice(2);
    const recomputed = createHmac('sha256', TEST_SECRET)
      .update(`${ts}.${body.toString('utf8')}`, 'utf8')
      .digest('hex');

    // HMAC over the captured bytes equals the transmitted HMAC
    expect(recomputed).toBe(v1Part!.slice(3));
  });
});
