/**
 * booking-service Express application factory.
 */
import express from "express";
import { createBookingRouter } from "./routes/bookings.js";
import { createItineraryRouter } from "./routes/itineraries.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import {
  createRateLimiter,
  createRateLimitMiddleware,
  FLOOR_LIMIT,
  WINDOW_MS,
  type RedisClient,
} from "@travel/ratelimit";
import type { BookingDomain } from "./routes/bookings.js";
import type { HealthHandlers } from "@travel/observability";
import type { ItineraryService } from "./domain/ItineraryService.js";
import type { TripDocumentService } from "./domain/TripDocumentService.js";

export interface BookingAppOptions {
  /**
   * Redis client for the per-service floor rate limiter.
   * When omitted, floor rate limiting is disabled (only safe in tests).
   */
  floorLimitRedis?: RedisClient;
  healthHandlers?: HealthHandlers;
  /** WO-053: wired ItineraryService for /itineraries routes. */
  itineraryService?: ItineraryService;
  /** WO-054: wired TripDocumentService for /itineraries/:id/documents routes. */
  documentService?: TripDocumentService;
}

export function createApp(
  domain: BookingDomain,
  healthHandlersOrOptions?: HealthHandlers | BookingAppOptions,
): express.Application {
  const options: BookingAppOptions =
    healthHandlersOrOptions !== undefined && "liveHandler" in healthHandlersOrOptions
      ? { healthHandlers: healthHandlersOrOptions as HealthHandlers }
      : (healthHandlersOrOptions as BookingAppOptions) ?? {};
  const { floorLimitRedis, healthHandlers, itineraryService, documentService } = options;

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // Per-service floor rate limiter — throttles direct in-mesh requests even
  // when the gateway is bypassed.
  if (floorLimitRedis) {
    const floorLimiter = createRateLimiter({
      redis: floorLimitRedis,
      windowMs: WINDOW_MS,
      limit: FLOOR_LIMIT,
    });
    app.use(
      createRateLimitMiddleware({
        limiter: floorLimiter,
        scope: "booking",
        getCostClass: (req) => {
          const r = req as unknown as { method?: string; path?: string };
          const m = (r.method ?? "GET").toUpperCase();
          if (m === "POST") return "expensive";
          return "cheap_read";
        },
      }),
    );
  }

  app.use("/bookings", createBookingRouter(domain));

  // WO-053: /v1/itineraries/** proxied by the gateway to booking-service.
  // JWT enforcement is applied at the gateway level; all itinerary routes
  // require the 'traveler' role (not on the guest allow-list).
  app.use("/itineraries", createItineraryRouter(itineraryService, documentService));

  if (healthHandlers !== undefined) {
    app.get("/health/live", healthHandlers.liveHandler.bind(healthHandlers));
    app.get("/health/ready", (req, res, next) => {
      (healthHandlers.readyHandler(req, res) as Promise<unknown>).catch(next);
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
