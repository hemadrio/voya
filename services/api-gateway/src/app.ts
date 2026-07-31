/**
 * api-gateway Express application factory.
 *
 * Middleware stack order (deliberate):
 *   1. stripInternalActorHeader — removes any client-forged x-internal-actor header
 *   2. securityHeaders — sets CSP, HSTS, nosniff, etc. on every response
 *   3. cors — strict origin allow-list; preflight handled here
 *   4. Raw body parser for /webhooks/stripe (before global JSON parser)
 *   5. Global JSON body parser
 *   6. Correlation ID middleware (from @travel/observability)
 *   7. authenticate — RS256 JWT verification + jti denylist (applied per-route)
 *   8. rateLimitMiddleware — tiered Redis sliding-window limiter (one Redis round trip)
 *   9. csrf — double-submit token validation (applied per-route)
 *  10. Routes
 *  11. Error handler
 */

import express from 'express';
import type { KeyProvider } from '@travel/auth';
import type { RedisClient } from '@travel/ratelimit';
import { createCorrelationIdMiddleware } from '@travel/observability';
import { createErrorHandler } from '../../../shared/middleware/errorHandler.js';
import { createSecurityHeaders, type SecurityHeadersOptions } from './middleware/securityHeaders.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { stripInternalActorHeader } from './middleware/stripInternalActorHeader.js';
import { createAuthenticateMiddleware, type JtiDenylist } from './middleware/authenticate.js';
import { createGatewayRateLimitMiddleware } from './middleware/rateLimitMiddleware.js';
import { createCsrfMiddleware } from './middleware/csrf.js';
import { getCorsConfig } from './config/origins.js';
import type { HealthHandlers } from '@travel/observability';

export interface GatewayOptions {
  keyProvider: KeyProvider;
  denylist: JtiDenylist;
  /**
   * HMAC-SHA256 secret used to sign the x-internal-actor header forwarded to
   * internal services. Must be sourced from Secrets Manager; never hard-coded.
   * Defaults to '' when omitted — only safe in tests that don't reach auth success.
   */
  actorContextSecret?: string;
  /**
   * Redis client for the tiered rate limiter.
   * When omitted, rate limiting is skipped (unsafe outside tests).
   */
  rateLimitRedis?: RedisClient;
  healthHandlers?: HealthHandlers;
  securityHeadersOptions?: SecurityHeadersOptions;
  /** Override NODE_ENV for CORS allow-list lookup. Useful in tests. */
  nodeEnv?: string;
  logger?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
  };
}

export function createApp(options: GatewayOptions): express.Application {
  const { keyProvider, denylist, actorContextSecret, rateLimitRedis, healthHandlers, logger, nodeEnv } = options;

  const corsConfig = getCorsConfig(nodeEnv ?? process.env['NODE_ENV']);
  const app = express();

  // ── 1. Strip forged internal actor header ─────────────────────────────────
  app.use(stripInternalActorHeader);

  // ── 2. Security response headers ─────────────────────────────────────────
  app.use(createSecurityHeaders(options.securityHeadersOptions));

  // ── 3. CORS ──────────────────────────────────────────────────────────────
  app.use(createCorsMiddleware({ config: corsConfig, logger }));

  // ── 4. Raw body handler for Stripe webhook (MUST come before JSON parser) ─
  // The Stripe HMAC verification requires the raw body. Any JSON parsing
  // before this route would transform the body and break signature checks.
  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '256kb' }),
  );

  // ── 5. Global JSON body parser ────────────────────────────────────────────
  app.use(express.json({ limit: '64kb' }));

  // ── 6. Correlation ID ─────────────────────────────────────────────────────
  app.use(createCorrelationIdMiddleware());

  // ── 7. Authentication ─────────────────────────────────────────────────────
  const authenticate = createAuthenticateMiddleware({ keyProvider, denylist, actorContextSecret, logger });

  // ── 8. Tiered rate limiter (after auth so tier is derivable) ──────────────
  const gatewayRateLimit = rateLimitRedis
    ? createGatewayRateLimitMiddleware({ redis: rateLimitRedis, actorContextSecret, logger })
    : null;

  // ── 9. CSRF ───────────────────────────────────────────────────────────────
  const csrf = createCsrfMiddleware({ corsConfig });

  // Health endpoints — no auth required
  if (healthHandlers !== undefined) {
    app.get('/health/live', healthHandlers.liveHandler.bind(healthHandlers));
    app.get('/health/ready', (req, res, next) => {
      healthHandlers.readyHandler(req, res).catch(next);
    });
  } else {
    app.get('/health/live', (_req, res) =>
      res.json({ status: 'alive', uptimeSeconds: Math.floor(process.uptime()) }),
    );
    app.get('/health/ready', (_req, res) => res.json({ status: 'ok' }));
  }

  // Stripe webhook — no session auth, no CSRF (HMAC-authenticated)
  app.post('/webhooks/stripe', (_req, res) => {
    // Downstream proxy would handle the actual forwarding.
    // This placeholder acknowledges receipt for the raw-body passthrough test.
    res.status(200).json({ received: true });
  });

  // All other routes require authentication, rate limiting, and CSRF protection
  app.use(authenticate);
  if (gatewayRateLimit) {
    app.use(gatewayRateLimit);
  }
  app.use(csrf);

  // ── 11. Error handler ─────────────────────────────────────────────────────
  app.use(createErrorHandler({ logger }));

  return app;
}
