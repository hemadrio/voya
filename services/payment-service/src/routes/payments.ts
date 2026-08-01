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
import { PaymentIntentRequestSchema, RefundRequestSchema } from "@travel/contracts";
import { validateRequest } from "../../../../shared/middleware/validateRequest.js";
import type { Request, Response } from "express";
import type { PaymentIntentService } from "../domain/PaymentIntentService.js";
import type { RefundService } from "../domain/RefundService.js";
import type { WebhookProcessor } from "../domain/WebhookProcessor.js";
import type { WebhookVerifier } from "../domain/WebhookVerifier.js";

// ---------------------------------------------------------------------------
// WebhookLogger — minimal structured logger interface for signature events
// ---------------------------------------------------------------------------

/** Structured logger for webhook security events. The implementation must
 *  write JSON to the log stream watched by the CloudWatch metric filter
 *  monitoring-log-filters.tf → "stripe-signature-invalid" filter. */
export interface WebhookSecurityEventWriter {
  /** Write a security event. The signing secret and raw body must never appear. */
  writeSignatureFailure(info: {
    sourceIp: string;
    signaturePresent: boolean;
    correlationId?: string;
    reason: string;
  }): void;
}

// ---------------------------------------------------------------------------
// Compiled validators (module scope — one-time cost)
// ---------------------------------------------------------------------------

const validateIntent = validateRequest({ body: PaymentIntentRequestSchema });
const validateRefund = validateRequest({ body: RefundRequestSchema });

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
  webhookSecurityEventWriter?: WebhookSecurityEventWriter,
  refundService?: RefundService,
  webhookVerifier?: WebhookVerifier,
  webhookProcessor?: WebhookProcessor,
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

  // ── POST /refunds — WO-049: idempotent refund through original payment route ──
  //
  // Route path: /refunds (mounted under /payments → full path /payments/refunds)
  // The api-gateway prefixes /v1, giving the contract path POST /v1/payments/refunds.
  //
  // Request body: { bookingId, amountMinor?, currency, reason, legId? }
  //   amountMinor omitted → full refund of remaining charge amount.
  //
  // Response 201: { data: { refundId, providerReference, amountMinor, currency, status, settlementWindow } }
  router.post(
    "/refunds",
    validateRefund,
    async (req: Request, res: Response): Promise<void> => {
      const reference = (req as Request & { correlationId?: string }).correlationId;

      if (!refundService) {
        res.status(501).json({
          error: { code: "NOT_IMPLEMENTED", message: "RefundService is not configured" },
          reference,
        });
        return;
      }

      const body = req.validated?.body as {
        bookingId: string;
        amountMinor?: number;
        currency: string;
        reason: string;
        legId?: string;
      };
      const actor = (req as Request & { actor?: { sub: string; roles: string[] } }).actor;

      const result = await refundService.issueRefund({
        bookingId: body.bookingId,
        amountMinor: body.amountMinor !== undefined ? BigInt(body.amountMinor) : undefined,
        currency: body.currency,
        reason: body.reason,
        legId: body.legId,
        actor: { id: actor?.sub ?? "", role: actor?.roles?.[0] ?? "traveler" },
        correlationId: reference,
      });

      res.status(201).json({
        data: {
          refundId: result.refundId,
          providerReference: result.providerReference,
          amountMinor: Number(result.amountMinor), // BigInt → Number for JSON
          currency: result.currency,
          status: result.status,
          settlementWindow: result.settlementWindow,
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

  // ── POST /webhook — RAW body, no Zod header validation ──────────────────
  //
  // The raw body parser is mounted at the app level (app.ts) BEFORE the
  // global express.json(), so the byte stream reaches this handler intact.
  // The expressRaw() call below is kept as a defence-in-depth safeguard for
  // callers that construct the router in isolation (e.g. tests that bypass
  // app.ts); body-parser skips re-parsing if req._body is already set.
  //
  // Intentionally NOT using validateWebhookHeaders (Zod schema) here — the
  // Zod validator would return VALIDATION_FAILED for a missing header, but
  // AC4 requires ALL signature failures (missing, malformed, invalid HMAC,
  // stale timestamp) to return SIGNATURE_VERIFICATION_FAILED.  WebhookVerifier
  // handles the missing-header case natively.
  //
  // On any verification failure:
  //   - Returns 400 SIGNATURE_VERIFICATION_FAILED (never 401 or 500)
  //   - Writes a security event with source IP, header presence, correlation ID
  //   - Emits structured log with event: "STRIPE_SIGNATURE_INVALID" for the
  //     CloudWatch metric filter → alarm
  //   - Zero state changes (domain.handleWebhook is never called on failure)
  router.post(
    "/webhook",
    expressRaw({ type: "application/json" }),
    async (req: Request, res: Response): Promise<void> => {
      const reference = (req as Request & { correlationId?: string }).correlationId;
      // May be undefined (missing), a string, or an array (take first element)
      const rawSig = req.headers["stripe-signature"];
      const signature = Array.isArray(rawSig) ? rawSig[0] : rawSig;

      // Helper: emit security event + metric log and respond 400.
      const rejectWithSignatureFailure = (reason: string): void => {
        const sourceIp = req.ip ?? "unknown";
        const signaturePresent = !!signature;
        const logEntry = JSON.stringify({
          level: 50, // Pino "error" level
          event: "STRIPE_SIGNATURE_INVALID",
          sourceIp,
          signaturePresent,
          correlationId: reference,
          reason,
          msg: "Stripe webhook signature verification failed",
        });
        process.stdout.write(logEntry + "\n");
        webhookSecurityEventWriter?.writeSignatureFailure({
          sourceIp,
          signaturePresent,
          correlationId: reference,
          reason,
        });
        res.status(400).json({
          error: {
            code: "SIGNATURE_VERIFICATION_FAILED",
            message: "Webhook signature verification failed.",
          },
          reference,
        });
      };

      // Pre-check: missing or empty signature header before reaching domain.
      if (!signature || signature.trim().length === 0) {
        rejectWithSignatureFailure("Missing or empty Stripe-Signature header");
        return;
      }

      try {
        // WO-047: Use WebhookProcessor (verify → dedup → process) when wired.
        // Falls back to legacy domain.handleWebhook for backward compat.
        if (webhookVerifier && webhookProcessor) {
          const rawBody = req.body as Buffer;
          const context = {
            requestId: reference,
            ipAddress: req.ip ?? "unknown",
          };
          // Verify first — throws SIGNATURE_VERIFICATION_FAILED on failure
          const event = webhookVerifier.verify(rawBody, signature, context);
          // Process with doubly-guarded idempotency
          const outcome = await webhookProcessor.process(event, rawBody, reference);
          res.status(200).json({ received: true, outcome });
        } else {
          // Legacy path
          await domain.handleWebhook(req.body as Buffer, signature);
          res.status(200).json({ received: true });
        }
      } catch (err: unknown) {
        const isDomainError =
          err !== null &&
          typeof err === "object" &&
          "code" in err;

        const code = isDomainError ? (err as { code: string }).code : null;

        if (
          code === "SIGNATURE_VERIFICATION_FAILED" ||
          code === "VALIDATION_FAILED"
        ) {
          // Reason must never contain the signing secret or raw body content.
          const reason = (err as { message?: string }).message ?? "verification failed";
          rejectWithSignatureFailure(reason);
          return;
        }

        // Unknown errors propagate to the error handler
        throw err;
      }
    },
  );

  return router;
}
