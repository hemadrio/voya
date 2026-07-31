/**
 * Payment service routes — intent creation and Stripe webhook.
 *
 * CRITICAL (AC7): The webhook route MUST use express.raw() body parser and
 * must validate ONLY the stripe-signature header — the raw body is passed
 * to Stripe's constructEvent for HMAC verification, which requires the
 * byte-for-byte original payload.  The JSON body parser must NOT run on
 * this path.
 *
 * Intent creation uses the JSON body parser and validates
 * PaymentIntentRequestSchema.
 */
import { Router, raw as expressRaw } from "express";
import { z } from "zod";
import { PaymentIntentRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";

// Compiled once at module scope.
const validateIntent = validateRequest({ body: PaymentIntentRequestSchema });

// Stripe webhook: validate only signature header presence.
// Use .passthrough() — many other headers will be present.
const WebhookHeadersSchema = z.object({
  "stripe-signature": z.string().min(1, "Stripe-Signature header is required for webhook verification"),
}).passthrough();
const validateWebhookHeaders = validateRequest({ headers: WebhookHeadersSchema });

export interface PaymentDomain {
  createIntent(body: unknown): Promise<unknown>;
  handleWebhook(rawBody: Buffer, signature: string): Promise<void>;
}

export function createPaymentRouter(domain: PaymentDomain): Router {
  const router = Router();

  // ── POST /payments/intent — JSON body, full schema validation ──────────
  router.post("/intent", validateIntent, async (req: Request, res: Response): Promise<void> => {
    const result = await domain.createIntent(req.validated?.body);
    res.status(201).json({ data: result });
  });

  // ── POST /payments/webhook — RAW body, header-only validation ─────────
  //
  // express.raw() is mounted here (path-scoped), NOT at the app level, so
  // the JSON parser that runs on all other routes does not apply here.
  // Byte-for-byte body preservation is required for Stripe HMAC verification.
  router.post(
    "/webhook",
    expressRaw({ type: "application/json" }),
    validateWebhookHeaders,
    async (req: Request, res: Response): Promise<void> => {
      const signature = (req.validated?.headers as { "stripe-signature": string })["stripe-signature"];
      // req.body is a Buffer here (not parsed JSON) — passed directly to Stripe
      await domain.handleWebhook(req.body as Buffer, signature);
      res.status(200).json({ received: true });
    },
  );

  return router;
}
