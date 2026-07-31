/**
 * auth-service Express application factory.
 */
import express from "express";
import { createAuthRouter } from "./routes/auth.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { AuthDomain } from "./routes/auth.js";

export function createApp(domain: AuthDomain): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/auth", createAuthRouter(domain));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(createErrorHandler());
  return app;
}
