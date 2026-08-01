/**
 * WebhookVerifier — Stripe webhook signature verification.
 *
 * Implements the Stripe signature verification algorithm without depending on
 * the Stripe SDK so this domain module stays framework-free and fully testable
 * with injected fakes.
 *
 * Algorithm:
 *   1. Parse the Stripe-Signature header (format: t=<timestamp>,v1=<hex>).
 *   2. Construct the signed payload: `${timestamp}.${rawBody}`.
 *   3. Compute HMAC-SHA256 of the signed payload using the webhook signing secret.
 *   4. Constant-time compare the computed signature against every v1 entry.
 *   5. Reject if the timestamp is older than toleranceSeconds (default 300 s).
 *
 * On failure the verifier:
 *   - Throws a DomainError with code SIGNATURE_VERIFICATION_FAILED (400-class).
 *   - Calls the injected security logger exactly once with actor and reason.
 *
 * Security invariant: the signing secret is never logged, even on failure.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { signatureVerificationFailed } from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface WebhookSecurityLogger {
  logForgedSignature(info: {
    reason: string;
    requestId?: string;
    ipAddress?: string;
  }): void;
}

export interface WebhookVerifierOptions {
  signingSecret: string;
  toleranceSeconds?: number;
  /** Clock function returning current time in **seconds**. Inject for tests. */
  clock?: () => number;
  securityLogger?: WebhookSecurityLogger;
}

export interface ParsedStripeEvent {
  id: string;
  type: string;
  data: unknown;
  livemode: boolean;
}

export interface VerifyContext {
  requestId?: string;
  ipAddress?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedHeader | null {
  const parts = header.split(",");
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      const parsed = parseInt(value, 10);
      if (!isFinite(parsed)) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      if (value.length > 0) signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

// ---------------------------------------------------------------------------
// WebhookVerifier class
// ---------------------------------------------------------------------------

export class WebhookVerifier {
  private readonly signingSecret: string;
  private readonly toleranceSeconds: number;
  private readonly clock: () => number;
  private readonly securityLogger: WebhookSecurityLogger | undefined;

  constructor(options: WebhookVerifierOptions) {
    this.signingSecret = options.signingSecret;
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.securityLogger = options.securityLogger;
  }

  /**
   * Verify the raw webhook body against its Stripe-Signature header.
   *
   * @throws {DomainError} SIGNATURE_VERIFICATION_FAILED (400) on any verification failure.
   *   The message describes the failure reason without disclosing the secret.
   */
  verify(
    rawBody: string | Buffer,
    signatureHeader: string | undefined | null,
    context: VerifyContext = {},
  ): ParsedStripeEvent {
    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

    if (!signatureHeader || signatureHeader.trim().length === 0) {
      this.fail("Missing Stripe-Signature header", context);
    }

    const parsed = parseSignatureHeader(signatureHeader!);
    if (!parsed) {
      this.fail("Malformed Stripe-Signature header", context);
    }

    const { timestamp, signatures } = parsed!;

    // Replay-protection: reject stale webhooks.
    const nowSeconds = this.clock();
    if (Math.abs(nowSeconds - timestamp) > this.toleranceSeconds) {
      this.fail(
        `Webhook timestamp is outside tolerance window (${this.toleranceSeconds}s)`,
        context,
      );
    }

    // Compute expected signature.
    const signedPayload = `${timestamp}.${body}`;
    const expectedHmac = createHmac("sha256", this.signingSecret)
      .update(signedPayload, "utf8")
      .digest();

    // Constant-time comparison against all v1 entries.
    const verified = signatures.some((sig) => {
      try {
        const sigBuf = Buffer.from(sig, "hex");
        // timingSafeEqual requires same-length buffers.
        if (sigBuf.length !== expectedHmac.length) return false;
        return timingSafeEqual(expectedHmac, sigBuf);
      } catch {
        return false;
      }
    });

    if (!verified) {
      this.fail("Webhook signature does not match", context);
    }

    // Parse the event body.
    let event: ParsedStripeEvent;
    try {
      event = JSON.parse(body) as ParsedStripeEvent;
    } catch {
      this.fail("Webhook body is not valid JSON", context);
    }

    return event!;
  }

  private fail(reason: string, context: VerifyContext): never {
    this.securityLogger?.logForgedSignature({
      reason,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
    });
    throw signatureVerificationFailed(`Webhook verification failed: ${reason}`) as DomainError;
  }
}
