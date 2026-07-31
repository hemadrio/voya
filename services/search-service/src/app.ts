/**
 * search-service Express application factory.
 *
 * Accepts a SearchAdapter so tests can inject fakes without a live supplier.
 * The app exposes:
 *   POST /search/flights
 *   POST /search/hotels
 *   POST /search/cars
 *   GET  /health
 *
 * Health is explicitly exempted from validation middleware (route-audit rule).
 */
import express from "express";
import { createFlightRouter } from "./routes/flights.js";
import { createHotelRouter } from "./routes/hotels.js";
import { createCarRouter } from "./routes/cars.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { SearchAdapter } from "./adapters/SearchAdapter.js";

export function createApp(adapter: SearchAdapter): express.Application {
  const app = express();

  // JSON body parser — applied to all routes except the Stripe webhook path
  // (not relevant for search-service, but pattern is documented here).
  app.use(express.json({ limit: "64kb" }));

  // Routes with per-schema validation
  app.use("/search/flights", createFlightRouter(adapter));
  app.use("/search/hotels", createHotelRouter(adapter));
  app.use("/search/cars", createCarRouter(adapter));

  // Health endpoint — explicitly exempt from validation middleware.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Shared error handler (WO-002)
  app.use(createErrorHandler());

  return app;
}
