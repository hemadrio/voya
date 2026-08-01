import { z } from "zod";
import { DataClassificationSchema, type DataClassification } from "./classification.js";

// ---------------------------------------------------------------------------
// Register entry schema
// ---------------------------------------------------------------------------

const ErasureMethodSchema = z.enum([
  "physical_delete",   // Row is deleted from the table
  "crypto_erasure",    // Wrapped DEK is destroyed (for KMS-encrypted fields)
  "pseudonymisation",  // Actor reference replaced with a fixed token
  "none",              // Not subject to GDPR erasure (excluded)
]);

export type ErasureMethod = z.infer<typeof ErasureMethodSchema>;

const RegisterEntrySchema = z.object({
  /** Internal identifier for this entry — unique across the register. */
  id: z.string().min(1),

  /** Human-readable category name. */
  category: z.string().min(1),

  /** Physical Postgres table name. */
  table: z.string().min(1),

  /**
   * Physical column names (scalar) or JSON-path expressions for JSON surfaces.
   * JSON paths use dot notation: "searchResultSnapshot.passengers[*].dateOfBirth"
   */
  columns: z.array(z.string().min(1)).min(1),

  /** Classification tier per the Data Classification policy. */
  classification: DataClassificationSchema,

  /**
   * Configuration key whose value holds the retention duration for this category.
   * Must match a key in RETENTION_CONFIG_KEYS.
   * null for categories whose retention is structural (e.g. session expiry).
   */
  retentionPeriodKey: z.string().nullable(),

  /**
   * Human-readable derivation expression.
   * Example: "created_at + INTERVAL 'transactionYears years'"
   */
  derivationExpression: z.string().min(1),

  /** Primary erasure method for this category. */
  erasureMethod: ErasureMethodSchema,

  /**
   * When true, this record is excluded from GDPR right-to-erasure processing.
   * Audit records are excluded; actor pseudonymisation is offered instead.
   */
  erasureExcluded: z.boolean(),

  /**
   * When erasureExcluded=true, documents the pseudonymisation rule for any
   * personal references so immutability and GDPR do not conflict.
   */
  pseudonymisationRule: z.string().optional(),

  /** Whether to include in a GDPR data subject rights export. */
  includedInDsrExport: z.boolean(),

  /** Whether this covers a JSON column surface (not a scalar column). */
  isJsonSurface: z.boolean().default(false),
});

export type RegisterEntry = z.infer<typeof RegisterEntrySchema>;

const ClassificationRegisterSchema = z.object({
  version: z.string().min(1),
  description: z.string(),
  entries: z.array(RegisterEntrySchema).min(1),
});

export type ClassificationRegister = z.infer<typeof ClassificationRegisterSchema>;

// ---------------------------------------------------------------------------
// The classification register — nine specification categories
// ---------------------------------------------------------------------------

const RAW_REGISTER = {
  version: "1.0.0",
  description:
    "Machine-readable data classification and retention register. " +
    "Single input for the automated purge job and GDPR DSR tooling. " +
    "Retention periods are configuration keys, not literals — unratified values " +
    "can be updated without a code deploy.",
  entries: [
    // ── 1. Account identity ──────────────────────────────────────────────
    {
      id: "users.identity",
      category: "Account identity",
      table: "users",
      columns: ["email", "password_hash", "failed_attempt_count", "locked_until"],
      classification: "RESTRICTED" satisfies DataClassification,
      retentionPeriodKey: "accountIdentityDays",
      derivationExpression:
        "erasure_requested_at + INTERVAL 'accountIdentityDays days' " +
        "(null while account is live; set when erasure request fulfilled)",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 2. Authentication / sessions ─────────────────────────────────────
    {
      id: "sessions.auth",
      category: "Authentication session",
      table: "sessions",
      columns: ["token", "refresh_token_hash", "family_id", "ip_address", "user_agent"],
      classification: "RESTRICTED" satisfies DataClassification,
      retentionPeriodKey: "sessionDays",
      derivationExpression: "expires_at + INTERVAL 'sessionDays days'",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: false,
      isJsonSurface: false,
    },

    // ── 3. One-time tokens ───────────────────────────────────────────────
    {
      id: "one_time_tokens.auth",
      category: "One-time authentication token",
      table: "one_time_tokens",
      columns: ["token_hash"],
      classification: "RESTRICTED" satisfies DataClassification,
      retentionPeriodKey: "sessionDays",
      derivationExpression: "expires_at + INTERVAL 'sessionDays days'",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: false,
      isJsonSurface: false,
    },

    // ── 4. Booking transaction ────────────────────────────────────────────
    {
      id: "bookings.transaction",
      category: "Booking transaction",
      table: "bookings",
      columns: [
        "user_id", "contact_email", "contact_phone", "total_price", "currency",
        "booking_type", "status", "offer_id", "idempotency_key",
      ],
      classification: "CONFIDENTIAL" satisfies DataClassification,
      retentionPeriodKey: "transactionYears",
      derivationExpression: "created_at + INTERVAL 'transactionYears years'",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 5. Search result snapshot (JSON surface) ─────────────────────────
    {
      id: "bookings.search_result_snapshot",
      category: "Booking search snapshot",
      table: "bookings",
      columns: ["search_result_snapshot"],
      classification: "CONFIDENTIAL" satisfies DataClassification,
      retentionPeriodKey: "transactionYears",
      derivationExpression: "created_at + INTERVAL 'transactionYears years'",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: true,
    },

    // ── 6. Traveler identity documents ───────────────────────────────────
    {
      id: "booking_travelers.identity_documents",
      category: "Traveler identity documents",
      table: "booking_travelers",
      columns: [
        "given_name", "family_name", "email",
        "encrypted_date_of_birth", "encrypted_passport_reference",
        "wrapped_dek",
      ],
      classification: "RESTRICTED" satisfies DataClassification,
      retentionPeriodKey: "identityDocumentDays",
      derivationExpression:
        "trip_completed_at + INTERVAL 'identityDocumentDays days' " +
        "(null until trip completion date is known)",
      erasureMethod: "crypto_erasure",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 7. Itinerary ──────────────────────────────────────────────────────
    {
      id: "itineraries.plan",
      category: "Itinerary",
      table: "itineraries",
      columns: ["user_id", "title", "notes"],
      classification: "CONFIDENTIAL" satisfies DataClassification,
      retentionPeriodKey: "itineraryYears",
      derivationExpression: "created_at + INTERVAL 'itineraryYears years'",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 8. Travel preferences ─────────────────────────────────────────────
    {
      id: "travel_preferences.profile",
      category: "Travel preferences",
      table: "travel_preferences",
      columns: [
        "user_id", "preferred_seat_class", "preferred_currency",
        "preferred_airlines", "dietary_restrictions",
      ],
      classification: "CONFIDENTIAL" satisfies DataClassification,
      retentionPeriodKey: "preferenceDays",
      derivationExpression:
        "updated_at + INTERVAL 'preferenceDays days' (follows account identity horizon)",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 9. Audit records (booking_audit_log) ──────────────────────────────
    {
      id: "booking_audit_log.audit",
      category: "Audit record",
      table: "booking_audit_log",
      columns: ["action", "previous_state", "new_state", "changed_by", "actor_id", "actor_role"],
      classification: "INTERNAL" satisfies DataClassification,
      retentionPeriodKey: "auditDays",
      derivationExpression:
        "occurred_at + INTERVAL 'auditDays days' (minimum 365; excluded from erasure sweep)",
      erasureMethod: "none",
      erasureExcluded: true,
      pseudonymisationRule:
        "actor_id replaced with SHA-256('REDACTED:' || actor_id) on erasure request; " +
        "booking_id retained for audit trail integrity",
      includedInDsrExport: false,
      isJsonSurface: false,
    },

    // ── 9b. Audit previous/new state JSON surfaces ────────────────────────
    {
      id: "booking_audit_log.state_json",
      category: "Audit state payload",
      table: "booking_audit_log",
      columns: ["previous_state", "new_state"],
      classification: "INTERNAL" satisfies DataClassification,
      retentionPeriodKey: "auditDays",
      derivationExpression:
        "occurred_at + INTERVAL 'auditDays days' (sanitised via sanitiseAuditPayload before write)",
      erasureMethod: "none",
      erasureExcluded: true,
      pseudonymisationRule:
        "Payloads are pre-sanitised by sanitiseAuditPayload() removing PII keys; " +
        "no post-write erasure needed for the JSON body",
      includedInDsrExport: false,
      isJsonSurface: true,
    },

    // ── 10. Conversation history ──────────────────────────────────────────
    {
      id: "conversation_history.redis",
      category: "Conversation history",
      table: "conversation_history",
      columns: ["messages"],
      classification: "CONFIDENTIAL" satisfies DataClassification,
      retentionPeriodKey: "conversationDays",
      derivationExpression:
        "last_message_at + INTERVAL 'conversationDays days' " +
        "(durable store decision: Redis with TTL; no Postgres table in this phase — " +
        "register entry documents the intent; purge enforced by Redis TTL configuration)",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      includedInDsrExport: true,
      isJsonSurface: false,
    },

    // ── 11. Funnel telemetry events (WO-106) ──────────────────────────────
    {
      id: "funnel_event.telemetry",
      category: "Funnel telemetry event",
      table: "funnel_event",
      columns: [
        "pseudonymous_actor_id", "session_id", "conversation_id",
        "itinerary_id", "booking_id", "attributes",
      ],
      classification: "INTERNAL" satisfies DataClassification,
      retentionPeriodKey: null,
      derivationExpression:
        "occurred_at + INTERVAL '400 days' " +
        "(purge_after computed at insert time in PrismaFunnelStore; " +
        "configurable via FUNNEL_RETENTION_DAYS env var)",
      erasureMethod: "physical_delete",
      erasureExcluded: false,
      pseudonymisationRule:
        "pseudonymous_actor_id is already an HMAC-SHA256 of the real userId; " +
        "physical_delete is applied once purge_after is reached; " +
        "no additional pseudonymisation step required on erasure",
      includedInDsrExport: false,
      isJsonSurface: false,
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Parse and validate at module load — a malformed register fails immediately
// ---------------------------------------------------------------------------

export const CLASSIFICATION_REGISTER: ClassificationRegister =
  ClassificationRegisterSchema.parse(RAW_REGISTER);

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** All entries for a given table name. */
export function getEntriesForTable(tableName: string): RegisterEntry[] {
  return CLASSIFICATION_REGISTER.entries.filter((e) => e.table === tableName);
}

/** Entry by its unique id. */
export function getEntryById(id: string): RegisterEntry | undefined {
  return CLASSIFICATION_REGISTER.entries.find((e) => e.id === id);
}

/** All entries that should be included in a GDPR DSR export for a user. */
export function getDsrExportEntries(): RegisterEntry[] {
  return CLASSIFICATION_REGISTER.entries.filter((e) => e.includedInDsrExport);
}

/** All entries that are excluded from erasure (audit records). */
export function getErasureExcludedEntries(): RegisterEntry[] {
  return CLASSIFICATION_REGISTER.entries.filter((e) => e.erasureExcluded);
}

/** All JSON surface entries (for the exhaustiveness test). */
export function getJsonSurfaceEntries(): RegisterEntry[] {
  return CLASSIFICATION_REGISTER.entries.filter((e) => e.isJsonSurface);
}
