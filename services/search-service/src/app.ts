/**
 * search-service Express application factory.
 *
 * Accepts a SearchAdapter so tests can inject fakes without a live supplier.
 * The app exposes:
 *   POST /search/flights
 *   POST /search/hotels
 *   POST /search/cars
 *   GET  /health/live   — liveness (no dependency calls)
 *   GET  /health/ready  — dependency-aware readiness
 *
 * Health is explicitly exempted from validation middleware (route-audit rule).
 */
import express from "express";
import { createFlightRouter } from "./routes/flights.js";
import { createHotelRouter } from "./routes/hotels.js";
import { createCarRouter } from "./routes/cars.js";
import { createOfferRouter } from "./routes/offers.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { SearchAdapter } from "./adapters/SearchAdapter.js";
import type { IOfferResolutionService } from "./domain/OfferResolutionService.js";
import type { HealthHandlers } from "@travel/observability";

export function createApp(
  adapter: SearchAdapter,
  offerResolutionService?: IOfferResolutionService,
  healthHandlers?: HealthHandlers,
): express.Application {
  const app = express();

  // JSON body parser — applied to all routes except the Stripe webhook path
  // (not relevant for search-service, but pattern is documented here).
  app.use(express.json({ limit: "64kb" }));

  // Routes with per-schema validation
  app.use("/search/flights", createFlightRouter(adapter));
  app.use("/search/hotels", createHotelRouter(adapter));
  app.use("/search/cars", createCarRouter(adapter));

  // Offer resolution — mounted at /v1/offers (no auth required)
  if (offerResolutionService !== undefined) {
    app.use("/v1/offers", createOfferRouter({ offerResolutionService }));
  }

  // Health endpoints — explicitly exempt from validation middleware.
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

  // Shared error handler (WO-002)
  app.use(createErrorHandler());

  return app;
}
