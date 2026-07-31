/**
 * booking-service Express application factory.
 */
import express from "express";
import { createBookingRouter } from "./routes/bookings.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { BookingDomain } from "./routes/bookings.js";

export function createApp(domain: BookingDomain): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/bookings", createBookingRouter(domain));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(createErrorHandler());
  return app;
}
