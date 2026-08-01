/**
 * payment-service Express application factory.
 *
 * Middleware order is deliberate — raw body parser for /payments/webhook MUST
 * be mounted at the app level BEFORE the global JSON parser.  Express
 * processes app.use() calls in registration order; if express.json() runs
 * first on the webhook path it consumes the stream and express.raw() receives
 * an empty buffer, breaking HMAC verification.
 *
 *   1. Raw body parser for /payments/webhook  ← MUST be first
 *   2. Global JSON body parser (all other routes)
 *   3. Payment router
 */
import express from "express";
import { createPaymentRouter } from "./routes/payments.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { PaymentDomain } from "./routes/payments.js";
import type { HealthHandlers } from "@travel/observability";

export function createApp(
  domain: PaymentDomain,
  healthHandlers?: HealthHandlers,
): express.Application {
  const app = express();

  // ── 1. Raw body parser for Stripe webhook (MUST come before JSON parser) ──
  // Stripe HMAC verification requires the byte-identical original payload.
  // Any JSON parsing before this path would transform the body and break
  // signature checks even though they pass locally with a parsed body.
  app.use(
    "/payments/webhook",
    express.raw({ type: "application/json", limit: "512kb" }),
  );

  // ── 2. Global JSON body parser (all routes except webhook) ────────────────
  app.use(express.json({ limit: "64kb" }));

  // ── 3. Payment routes ─────────────────────────────────────────────────────
  app.use("/payments", createPaymentRouter(domain));

  if (healthHandlers !== undefined) {
    app.get("/health/live", healthHandlers.liveHandler.bind(healthHandlers));
    app.get("/health/ready", (req, res, next) => {
      healthHandlers.readyHandler(req, res).catch(next);
    });
  } else {
    app.get("/health/live", (_req, res) =>
      res.json({ status: "alive", uptimeSeconds: Math.floor(process.uptime()) }),
    );
    app.get("/health/ready", (_req, res) => res.json({ status: "ok" }));
  }

  app.use(createErrorHandler());
  return app;
}
