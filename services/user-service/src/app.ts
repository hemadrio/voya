/**
 * user-service Express application factory.
 */
import express from "express";
import { createUserRouter } from "./routes/users.js";
import { createErrorHandler } from "../../../shared/middleware/errorHandler.js";
import type { UserDomain } from "./routes/users.js";

export function createApp(domain: UserDomain): express.Application {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/users", createUserRouter(domain));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(createErrorHandler());
  return app;
}
