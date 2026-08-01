/**
 * Validated boot configuration for ai-service (WO-059).
 *
 * All caps and rate-limit values are read from environment variables with
 * sane defaults and range validation so misconfigured values fail fast at
 * startup rather than silently using unsafe values.
 *
 * Caps are SERVER-SIDE ONLY: they cannot be overridden by request body,
 * headers, query parameters, or model output.
 */

import { z } from "zod";
import type { BudgetCaps } from "../domain/budget/BudgetGuard.js";
import type { BudgetRateLimitConfig } from "../infrastructure/ratelimit/TurnRateLimiter.js";

// ---------------------------------------------------------------------------
// Cap defaults (sane, conservative)
// ---------------------------------------------------------------------------

const DEFAULT_CAPS: BudgetCaps = {
  maxToolCallsPerTurn: 10,
  maxIterationsPerTurn: 5,
  maxInputTokensPerCall: 50_000,
  maxOutputTokensPerTurn: 8_000,
  maxConversationTokens: 200_000,
  maxDurationMs: 60_000,
};

// ---------------------------------------------------------------------------
// Rate-limit defaults
// ---------------------------------------------------------------------------

const DEFAULT_RATE_LIMITS: BudgetRateLimitConfig = {
  authenticated: { perMinute: 10, perHour: 100 },
  guest: { perMinute: 3, perHour: 20 },
};

// ---------------------------------------------------------------------------
// Zod validation schema with range checks
// ---------------------------------------------------------------------------

function envInt(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    throw new Error(`Config error: ${key} is not a valid integer (got "${raw}")`);
  }
  return n;
}

const CapsConfigSchema = z.object({
  maxToolCallsPerTurn: z.number().int().min(1).max(50),
  maxIterationsPerTurn: z.number().int().min(1).max(20),
  maxInputTokensPerCall: z.number().int().min(1000).max(200_000),
  maxOutputTokensPerTurn: z.number().int().min(100).max(50_000),
  maxConversationTokens: z.number().int().min(1000).max(2_000_000),
  maxDurationMs: z.number().int().min(5_000).max(300_000),
});

const RateLimitConfigSchema = z.object({
  authenticated: z.object({
    perMinute: z.number().int().min(1).max(1000),
    perHour: z.number().int().min(1).max(10_000),
  }),
  guest: z.object({
    perMinute: z.number().int().min(1).max(100),
    perHour: z.number().int().min(1).max(1000),
  }),
});

// ---------------------------------------------------------------------------
// loadBudgetConfig — fail-fast on invalid values
// ---------------------------------------------------------------------------

export function loadBudgetConfig(): { caps: BudgetCaps; rateLimits: BudgetRateLimitConfig } {
  const rawCaps = {
    maxToolCallsPerTurn: envInt("AI_MAX_TOOL_CALLS_PER_TURN", DEFAULT_CAPS.maxToolCallsPerTurn),
    maxIterationsPerTurn: envInt("AI_MAX_ITERATIONS_PER_TURN", DEFAULT_CAPS.maxIterationsPerTurn),
    maxInputTokensPerCall: envInt("AI_MAX_INPUT_TOKENS_PER_CALL", DEFAULT_CAPS.maxInputTokensPerCall),
    maxOutputTokensPerTurn: envInt("AI_MAX_OUTPUT_TOKENS_PER_TURN", DEFAULT_CAPS.maxOutputTokensPerTurn),
    maxConversationTokens: envInt("AI_MAX_CONVERSATION_TOKENS", DEFAULT_CAPS.maxConversationTokens),
    maxDurationMs: envInt("AI_MAX_DURATION_MS", DEFAULT_CAPS.maxDurationMs),
  };

  const rawRateLimits = {
    authenticated: {
      perMinute: envInt("AI_RATE_AUTH_PER_MINUTE", DEFAULT_RATE_LIMITS.authenticated.perMinute),
      perHour: envInt("AI_RATE_AUTH_PER_HOUR", DEFAULT_RATE_LIMITS.authenticated.perHour),
    },
    guest: {
      perMinute: envInt("AI_RATE_GUEST_PER_MINUTE", DEFAULT_RATE_LIMITS.guest.perMinute),
      perHour: envInt("AI_RATE_GUEST_PER_HOUR", DEFAULT_RATE_LIMITS.guest.perHour),
    },
  };

  const capsResult = CapsConfigSchema.safeParse(rawCaps);
  if (!capsResult.success) {
    const issues = capsResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Budget caps configuration invalid: ${issues}`);
  }

  const rlResult = RateLimitConfigSchema.safeParse(rawRateLimits);
  if (!rlResult.success) {
    const issues = rlResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Rate-limit configuration invalid: ${issues}`);
  }

  return { caps: capsResult.data, rateLimits: rlResult.data };
}
