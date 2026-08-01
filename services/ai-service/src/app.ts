/**
 * ai-service Express application factory.
 */
import express from "express";
import type { HealthHandlers } from "@travel/observability";
import type { ChatStreamDeps } from "./api/routes/chatStream.js";
import { createChatStreamRouter } from "./api/routes/chatStream.js";

export interface AiAppOptions {
  healthHandlers?: HealthHandlers;
  /** WO-058: wired chat streaming deps for /assistant/conversations routes. */
  chatStreamDeps?: ChatStreamDeps;
}

export function createApp(healthHandlersOrOptions?: HealthHandlers | AiAppOptions): express.Application {
  const options: AiAppOptions =
    healthHandlersOrOptions !== undefined && "liveHandler" in (healthHandlersOrOptions as object)
      ? { healthHandlers: healthHandlersOrOptions as HealthHandlers }
      : (healthHandlersOrOptions as AiAppOptions) ?? {};
  const { healthHandlers, chatStreamDeps } = options;

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // WO-058: /assistant/conversations routes (wired when chatStreamDeps is injected)
  if (chatStreamDeps) {
    app.use("/assistant/conversations", createChatStreamRouter(chatStreamDeps));
  }

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
