/**
 * user-service Express application factory.
 */
import express from "express";
import { createUserRouter } from "./routes/users.js";
import { createMeRouter } from "./routes/me.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import {
  createRateLimiter,
  createRateLimitMiddleware,
  FLOOR_LIMIT,
  WINDOW_MS,
  type RedisClient,
} from "@travel/ratelimit";
import type { UserDomain } from "./routes/users.js";
import type { DataSubjectRightsService } from "./services/DataSubjectRightsService.js";
import type { HealthHandlers } from "@travel/observability";

export interface UserAppOptions {
  /**
   * Redis client for the per-service floor rate limiter.
   * When omitted, floor rate limiting is disabled (only safe in tests).
   */
  floorLimitRedis?: RedisClient;
  healthHandlers?: HealthHandlers;
  /** GDPR data-subject rights service. When omitted /v1/me routes are not mounted. */
  dsrService?: DataSubjectRightsService;
}

export function createApp(
  domain: UserDomain,
  healthHandlersOrOptions?: HealthHandlers | UserAppOptions,
): express.Application {
  const options: UserAppOptions =
    healthHandlersOrOptions !== undefined && "liveHandler" in healthHandlersOrOptions
      ? { healthHandlers: healthHandlersOrOptions as HealthHandlers }
      : (healthHandlersOrOptions as UserAppOptions) ?? {};
  const { floorLimitRedis, healthHandlers, dsrService } = options;

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
        scope: "user",
        getCostClass: (req) => {
          const r = req as unknown as { method?: string };
          return (r.method ?? "GET").toUpperCase() === "GET" ? "cheap_read" : "standard";
        },
      }),
    );
  }

  app.use("/users", createUserRouter(domain));

  if (dsrService) {
    app.use("/v1/me", createMeRouter(dsrService));
  }

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
