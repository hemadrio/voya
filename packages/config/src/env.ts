/**
 * Shared environment schema for the travel platform.
 *
 * Provides a composable Zod base schema covering every variable consumed
 * across the nine services and the web application. Service-specific schema
 * groups extend the base so each service imports only the slice it needs.
 *
 * Design decisions:
 *   - All schemas use z.coerce.number() for PORT so "3001" parses correctly
 *     from process.env string values.
 *   - Placeholder detection is a separate concern handled by validate-startup.ts;
 *     this module only enforces shape and type.
 *   - Service schemas export a frozen typed config object via parseEnv() —
 *     callers never read process.env directly.
 *   - NEXT_PUBLIC_* variables are excluded from backend schemas; the frontend
 *     uses its own Zod schema in frontend/lib/env.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable field definitions
// ---------------------------------------------------------------------------

const logLevelSchema = z
  .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
  .default("info");

const nodeEnvSchema = z
  .enum(["development", "test", "staging", "production"])
  .default("development");

const portSchema = z.coerce.number().int().min(1).max(65535);

const databaseUrlSchema = z
  .string()
  .min(20)
  .refine((u) => u.startsWith("postgresql://") || u.startsWith("postgres://"), {
    message: "DATABASE_URL must be a postgresql:// URL",
  });

const redisUrlSchema = z
  .string()
  .min(10)
  .refine((u) => u.startsWith("redis://") || u.startsWith("rediss://"), {
    message: "REDIS_URL must be a redis:// or rediss:// URL",
  });

// ---------------------------------------------------------------------------
// Base schema — common to every backend service
// ---------------------------------------------------------------------------

export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  PORT: portSchema,
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

// ---------------------------------------------------------------------------
// Credential groups — mixed into per-service schemas
// ---------------------------------------------------------------------------

export const dbEnvSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
});

export const redisEnvSchema = z.object({
  REDIS_URL: redisUrlSchema,
});

export const jwtPublicKeyEnvSchema = z.object({
  JWT_PUBLIC_KEY: z.string().min(50),
});

export const jwtSigningKeyEnvSchema = z.object({
  JWT_SECRET: z.string().min(32),
});

export const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(20),
  STRIPE_WEBHOOK_SECRET: z.string().min(10),
});

export const amadeusEnvSchema = z.object({
  AMADEUS_CLIENT_ID: z.string().min(1),
  AMADEUS_CLIENT_SECRET: z.string().min(1),
});

export const rapidApiEnvSchema = z.object({
  RAPIDAPI_KEY: z.string().min(1),
});

export const anthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(20),
});

export const sqsConsumerEnvSchema = z.object({
  SQS_QUEUE_URL: z.string().url(),
});

export const sesEnvSchema = z.object({
  SES_FROM_ADDRESS: z.string().email(),
});

export const googleOauthEnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(10).optional(),
});

// ---------------------------------------------------------------------------
// Per-service schemas
//
// Each schema merges the base with the credential groups the service needs.
// Exports are consumed by validate-startup.ts and by service-specific config
// loaders to produce a typed frozen config object.
// ---------------------------------------------------------------------------

/** api-gateway — JWT verification + Redis jti denylist */
export const apiGatewayEnvSchema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({ PORT: portSchema.default(3000) });

/** auth-service — signs JWTs, verifies passwords, stores sessions */
export const authServiceEnvSchema = baseEnvSchema
  .merge(dbEnvSchema)
  .merge(jwtSigningKeyEnvSchema)
  .merge(googleOauthEnvSchema)
  .extend({
    PORT: portSchema.default(3001),
    REDIS_URL: redisUrlSchema.optional(),
  });

/** user-service — manages traveler profiles */
export const userServiceEnvSchema = baseEnvSchema
  .merge(dbEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({ PORT: portSchema.default(3002) });

/** flight-service — Amadeus GDS fan-out, Redis cache */
export const flightServiceEnvSchema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({
    PORT: portSchema.default(3003),
    AMADEUS_CLIENT_ID: z.string().min(1).optional(),
    AMADEUS_CLIENT_SECRET: z.string().min(1).optional(),
  });

/** hotel-service — RapidAPI fan-out, Redis cache */
export const hotelServiceEnvSchema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({
    PORT: portSchema.default(3004),
    RAPIDAPI_KEY: z.string().min(1).optional(),
  });

/** car-service — RapidAPI fan-out, Redis cache */
export const carServiceEnvSchema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({
    PORT: portSchema.default(3005),
    RAPIDAPI_KEY: z.string().min(1).optional(),
  });

/** booking-service — saga orchestrator, SQS publisher */
export const bookingServiceEnvSchema = baseEnvSchema
  .merge(dbEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({
    PORT: portSchema.default(3006),
    SQS_QUEUE_URL: z.string().url().optional(),
  });

/** payment-service — Stripe API + webhook HMAC verification */
export const paymentServiceEnvSchema = baseEnvSchema
  .merge(dbEnvSchema)
  .merge(stripeEnvSchema)
  .merge(jwtPublicKeyEnvSchema)
  .extend({ PORT: portSchema.default(3007) });

/** ai-orchestration — Anthropic Claude, Redis conversation state */
export const aiOrchestrationEnvSchema = baseEnvSchema
  .merge(jwtPublicKeyEnvSchema)
  .extend({
    PORT: portSchema.default(3008),
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    REDIS_URL: redisUrlSchema.optional(),
  });

/** notification-consumer — SQS FIFO consumer, SES sender */
export const notificationConsumerEnvSchema = baseEnvSchema
  .merge(dbEnvSchema)
  .merge(redisEnvSchema)
  .merge(sqsConsumerEnvSchema)
  .merge(sesEnvSchema)
  .extend({ PORT: portSchema.default(3009) });

// ---------------------------------------------------------------------------
// Platform-wide env type (union of all variables)
// ---------------------------------------------------------------------------

export const platformEnvSchema = baseEnvSchema
  .merge(dbEnvSchema.partial())
  .merge(redisEnvSchema.partial())
  .merge(jwtPublicKeyEnvSchema.partial())
  .merge(jwtSigningKeyEnvSchema.partial())
  .merge(stripeEnvSchema.partial())
  .merge(amadeusEnvSchema.partial())
  .merge(rapidApiEnvSchema.partial())
  .merge(anthropicEnvSchema.partial())
  .merge(sqsConsumerEnvSchema.partial())
  .merge(sesEnvSchema.partial())
  .merge(googleOauthEnvSchema);

export type PlatformEnv = z.infer<typeof platformEnvSchema>;

// ---------------------------------------------------------------------------
// parseEnv — safe parse helper used by services and the startup validator
// ---------------------------------------------------------------------------

export interface ParseEnvSuccess<T> {
  readonly ok: true;
  readonly config: T;
}

export interface ParseEnvFailure {
  readonly ok: false;
  readonly errors: ReadonlyArray<{ path: string; message: string }>;
}

export type ParseEnvResult<T> = ParseEnvSuccess<T> | ParseEnvFailure;

/**
 * Parse an environment record against a Zod schema.
 *
 * Does NOT call process.exit — that is the responsibility of the startup
 * validator. This function is pure and suitable for unit tests.
 *
 * @param schema - The Zod schema describing the required environment shape.
 * @param env - The environment record to parse (pass process.env or a fixture).
 * @returns A typed result discriminated by `ok`.
 */
export function parseEnv<T>(
  schema: z.ZodType<T>,
  env: Readonly<Record<string, string | undefined>>,
): ParseEnvResult<T> {
  const result = schema.safeParse(env);

  if (result.success) {
    return { ok: true, config: Object.freeze(result.data) as T };
  }

  const errors = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));

  return { ok: false, errors };
}
