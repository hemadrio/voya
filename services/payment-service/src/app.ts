/**
 * payment-service Express application factory.
 *
 * NOTE: The JSON body parser is applied globally, but the webhook route
 * overrides it with express.raw() at the route level (path-scoped).
 * Express applies route-level middleware before app-level for that path,
 * so the raw body parser wins on /payments/webhook.
 */
import express from "express";
import { createPaymentRouter } from "./routes/payments.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { PaymentDomain } from "./routes/payments.js";

export function createApp(domain: PaymentDomain): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/payments", createPaymentRouter(domain));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(createErrorHandler());
  return app;
}
