/**
 * Payment service routes — intent creation and Stripe webhook.
 *
 * CRITICAL: The webhook route MUST use express.raw() body parser and
 * must validate ONLY the stripe-signature header — the raw body is passed
 * to Stripe's constructEvent for HMAC verification, which requires the
 * byte-for-byte original payload.  The JSON body parser must NOT run on
 * this path.
 *
 * WO-045 additions:
 *   POST /intents — idempotent PaymentIntent creation gated on booking
 *     payability (WO-042 preconditions: PENDING + re-validated + price-accepted).
 *     Amount is derived server-side from the booking; client-supplied amounts
 *     are rejected.  Response includes only clientSecret, amountMinor,
 *     currency, status, paymentId — never the Stripe secret key.
 *
 * PCI note: no route in this file may accept a full card number, CVC, or
 * expiry date.  Card capture happens via Stripe-hosted fields in the browser.
 */
import { Router, raw as expressRaw } from "express";
import { z } from "zod";
import { PaymentIntentRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";
import type { PaymentIntentService } from "../domain/PaymentIntentService.js";

// ---------------------------------------------------------------------------
// Compiled validators (module scope — one-time cost)
// ---------------------------------------------------------------------------

const validateIntent = validateRequest({ body: PaymentIntentRequestSchema });

const BookingIdParamsSchema = z.object({}).passthrough(); // params not used for POST /intents

// Stripe webhook: validate only signature header presence.
const WebhookHeadersSchema = z
  .object({
    "stripe-signature": z.string().min(1, "Stripe-Signature header is required for webhook verification"),
  })
  .passthrough();
const validateWebhookHeaders = validateRequest({ headers: WebhookHeadersSchema });

// ---------------------------------------------------------------------------
// Legacy domain interface (pre-WO-045, kept for backward compat)
// ---------------------------------------------------------------------------

export interface PaymentDomain {
  createIntent(body: unknown): Promise<unknown>;
  handleWebhook(rawBody: Buffer, signature: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createPaymentRouter(
  domain: PaymentDomain,
  paymentIntentService?: PaymentIntentService,
): Router {
  const router = Router();

  // ── POST /intents — WO-045: idempotent, server-side amount, WO-042 gated ──
  //
  // Route path: /intents (mounted under /payments → full path /payments/intents)
  // The api-gateway prefixes /v1, giving the contract path POST /v1/payments/intents.
  //
  // Request body: { bookingId: string, currency: string }
  //   No amount field — the platform derives it from the booking's re-validated total.
  //
  // Response 201: { data: { clientSecret, amountMinor, currency, status, paymentId } }
  router.post(
    "/intents",
    validateIntent,
    async (req: Request, res: Response): Promise<void> => {
      const reference = (req as Request & { correlationId?: string }).correlationId;

      if (!paymentIntentService) {
        res.status(501).json({
          error: { code: "NOT_IMPLEMENTED", message: "PaymentIntentService is not configured" },
          reference,
        });
        return;
      }

      const body = req.validated?.body as { bookingId: string; currency: string };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;

      const result = await paymentIntentService.createIntent(
        body.bookingId,
        body.currency,
        { id: actor?.sub ?? "", role: actor?.roles?.[0] ?? "traveler" },
        reference,
      );

      res.status(201).json({
        data: {
          clientSecret: result.clientSecret,
          amountMinor: Number(result.amountMinor), // BigInt → Number for JSON
          currency: result.currency,
          status: result.status,
          paymentId: result.paymentId,
        },
        reference,
      });
    },
  );

  // ── POST /intent — legacy route kept for backward compat ─────────────────
  router.post(
    "/intent",
    validateIntent,
    async (req: Request, res: Response): Promise<void> => {
      const result = await domain.createIntent(req.validated?.body);
      res.status(201).json({ data: result });
    },
  );

  // ── POST /webhook — RAW body, header-only validation ─────────────────────
  //
  // express.raw() is mounted here (path-scoped), NOT at the app level, so
  // the JSON parser that runs on all other routes does not apply here.
  // Byte-for-byte body preservation is required for Stripe HMAC verification.
  router.post(
    "/webhook",
    expressRaw({ type: "application/json" }),
    validateWebhookHeaders,
    async (req: Request, res: Response): Promise<void> => {
      const signature = (req.validated?.headers as { "stripe-signature": string })[
        "stripe-signature"
      ];
      // req.body is a Buffer here (not parsed JSON) — passed directly to Stripe
      await domain.handleWebhook(req.body as Buffer, signature);
      res.status(200).json({ received: true });
    },
  );

  return router;
}
