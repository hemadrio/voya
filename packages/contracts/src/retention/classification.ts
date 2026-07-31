import { z } from "zod";

// ---------------------------------------------------------------------------
// DataClassification — four-tier classification scheme
// ---------------------------------------------------------------------------

/**
 * Classification tiers per the Data Classification policy.
 *
 * PUBLIC      — no handling restrictions (e.g. marketing copy)
 * INTERNAL    — internal use only (e.g. audit logs, system metadata)
 * CONFIDENTIAL — business-sensitive (e.g. booking transaction records)
 * RESTRICTED  — highest sensitivity; PII and payment-adjacent data
 *               (e.g. identity documents, date of birth, passport numbers)
 */
export const DATA_CLASSIFICATION_VALUES = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
] as const;

export const DataClassificationSchema = z.enum(DATA_CLASSIFICATION_VALUES);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

// ---------------------------------------------------------------------------
// Retention period configuration keys
// ---------------------------------------------------------------------------

/**
 * Configuration keys for retention periods.
 * Values are resolved from environment variables or Parameter Store at startup.
 * Literal day counts are intentionally absent from code (constraint: unratified periods).
 */
export const RETENTION_CONFIG_KEYS = {
  /** Days to retain account identity data after an erasure request is fulfilled. */
  accountIdentityDays: "RETENTION_ACCOUNT_IDENTITY_DAYS",
  /** Years to retain booking transaction records (tax/dispute purposes). */
  transactionYears: "RETENTION_TRANSACTION_YEARS",
  /** Days to retain identity document data after trip completion. */
  identityDocumentDays: "RETENTION_IDENTITY_DOCUMENT_DAYS",
  /** Days to retain expired sessions (covered by expires_at). */
  sessionDays: "RETENTION_SESSION_DAYS",
  /** Years to retain itinerary records (follows transaction horizon). */
  itineraryYears: "RETENTION_ITINERARY_YEARS",
  /** Days to retain travel preferences (follows account identity horizon). */
  preferenceDays: "RETENTION_PREFERENCE_DAYS",
  /** Days to retain conversation history after last message (Redis TTL backed). */
  conversationDays: "RETENTION_CONVERSATION_DAYS",
  /** Minimum days to retain audit records (excluded from erasure). */
  auditDays: "RETENTION_AUDIT_DAYS",
} as const satisfies Record<string, string>;

export type RetentionConfigKey = keyof typeof RETENTION_CONFIG_KEYS;
export type RetentionConfigEnvVar = (typeof RETENTION_CONFIG_KEYS)[RetentionConfigKey];

// ---------------------------------------------------------------------------
// Retention configuration value schema
// ---------------------------------------------------------------------------

/**
 * Parsed retention configuration — all values are positive integers.
 * Resolved at startup; services refuse to boot if any key is absent.
 */
export const RetentionConfigSchema = z.object({
  accountIdentityDays: z.number().int().positive(),
  transactionYears: z.number().int().positive(),
  identityDocumentDays: z.number().int().positive(),
  sessionDays: z.number().int().positive(),
  itineraryYears: z.number().int().positive(),
  preferenceDays: z.number().int().positive(),
  conversationDays: z.number().int().positive(),
  auditDays: z.number().int().positive().min(365),
});

export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
