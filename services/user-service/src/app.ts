/**
 * user-service Express application factory.
 */
import express from "express";
import { createUserRouter } from "./routes/users.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { UserDomain } from "./routes/users.js";
import type { HealthHandlers } from "@travel/observability";

export function createApp(
  domain: UserDomain,
  healthHandlers?: HealthHandlers,
): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/users", createUserRouter(domain));

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
