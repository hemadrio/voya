/**
 * itinerary-service Express application factory.
 *
 * Exposes health endpoints only at this stage; itinerary routes are wired in
 * subsequent work orders.
 */
import express from "express";
import type { HealthHandlers } from "@travel/observability";

export function createApp(healthHandlers?: HealthHandlers): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

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

  return app;
}
