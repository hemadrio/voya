/**
 * retentionConfig — reads and validates retention period configuration.
 *
 * Retention durations are configuration values, not literals in code, because
 * several periods are unratified by Legal and Finance (constraint). Services
 * call loadRetentionConfig() at startup; the function throws if any required
 * key is absent so the service refuses to boot rather than silently using
 * undefined periods.
 *
 * Pattern mirrors the secret-validation approach in packages/config.
 */

import { RETENTION_CONFIG_KEYS, RetentionConfigSchema } from "@travel/contracts/retention";
import type { RetentionConfig } from "@travel/contracts/retention";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// Environment variable reader
// ---------------------------------------------------------------------------

function readEnvInt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = parseInt(raw, 10);
  return isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate all retention period configuration values from environment
 * variables. Throws a descriptive error naming any missing or invalid keys.
 *
 * Call once at service startup before any purge_after derivation.
 */
export function loadRetentionConfig(): RetentionConfig {
  const raw = {
    accountIdentityDays: readEnvInt(RETENTION_CONFIG_KEYS.accountIdentityDays),
    transactionYears: readEnvInt(RETENTION_CONFIG_KEYS.transactionYears),
    identityDocumentDays: readEnvInt(RETENTION_CONFIG_KEYS.identityDocumentDays),
    sessionDays: readEnvInt(RETENTION_CONFIG_KEYS.sessionDays),
    itineraryYears: readEnvInt(RETENTION_CONFIG_KEYS.itineraryYears),
    preferenceDays: readEnvInt(RETENTION_CONFIG_KEYS.preferenceDays),
    conversationDays: readEnvInt(RETENTION_CONFIG_KEYS.conversationDays),
    auditDays: readEnvInt(RETENTION_CONFIG_KEYS.auditDays),
  };

  try {
    return RetentionConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const missing = err.issues
        .filter((i) => i.code === "invalid_type" && i.received === "undefined")
        .map((i) => {
          const field = i.path.join(".");
          const envKey = RETENTION_CONFIG_KEYS[field as keyof typeof RETENTION_CONFIG_KEYS];
          return envKey ? `${envKey} (${field})` : field;
        });

      const invalid = err.issues
        .filter((i) => i.code !== "invalid_type" || i.received !== "undefined")
        .map((i) => `${i.path.join(".")}: ${i.message}`);

      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(`Missing required retention config keys: ${missing.join(", ")}`);
      }
      if (invalid.length > 0) {
        parts.push(`Invalid retention config values: ${invalid.join("; ")}`);
      }

      throw new Error(
        `[retention] Service startup refused — retention configuration is incomplete.\n${parts.join("\n")}\n` +
          `Set the above environment variables before starting the service.`,
      );
    }
    throw err;
  }
}

/**
 * Build a RetentionConfig from explicit values (for testing without env vars).
 */
export function buildRetentionConfig(values: {
  accountIdentityDays: number;
  transactionYears: number;
  identityDocumentDays: number;
  sessionDays: number;
  itineraryYears: number;
  preferenceDays: number;
  conversationDays: number;
  auditDays: number;
}): RetentionConfig {
  return RetentionConfigSchema.parse(values);
}
