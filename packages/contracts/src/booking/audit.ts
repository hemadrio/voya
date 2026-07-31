/**
 * Audit payload sanitiser — strips PII from booking state snapshots before
 * they are persisted in booking_audit_log.
 *
 * Audit rows are excluded from GDPR erasure and retained for ≥ 1 year, so
 * they must never carry identity-document data.  This pure function is the
 * single enforcement point.
 *
 * Key list mirrors the Pino redaction paths in @travel/observability so both
 * layers strip the same fields.  The function traverses nested objects and
 * arrays so deeply-nested passenger data inside searchResultSnapshot is
 * also stripped.
 *
 * No external dependencies — safe to use in any service without bringing in
 * a logger or other infrastructure.
 */

// ---------------------------------------------------------------------------
// Redaction key set (matches @travel/observability PII_REDACT_PATHS)
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear in audit payloads.
 * Exportable so callers can audit-log which keys were stripped.
 */
export const AUDIT_REDACT_KEYS: ReadonlySet<string> = new Set([
  "email",
  "passwordHash",
  "dateOfBirth",
  "passportNumber",
  "authorization",
  "stripe-signature",
  "Authorization",
  // Defensive extras aligned with observability logger
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "password",
]);

const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Sanitiser implementation
// ---------------------------------------------------------------------------

/**
 * Recursively traverse `record` and replace any value whose key appears in
 * `redactKeys` with `"[REDACTED]"`.  Returns a deep-cloned, sanitised copy.
 *
 * @param record     - Any unknown value (object, array, primitive).
 * @param redactKeys - Keys to redact; defaults to AUDIT_REDACT_KEYS.
 */
export function sanitiseAuditPayload(
  record: unknown,
  redactKeys: ReadonlySet<string> = AUDIT_REDACT_KEYS,
): unknown {
  if (record === null || typeof record !== "object") {
    // Primitives and null pass through unchanged.
    return record;
  }

  if (Array.isArray(record)) {
    return record.map((item) => sanitiseAuditPayload(item, redactKeys));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (redactKeys.has(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = sanitiseAuditPayload(value, redactKeys);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Branded type so callers cannot accidentally pass an un-sanitised snapshot. */
export type SanitisedPayload = Readonly<Record<string, unknown>> & {
  readonly __brand: "SanitisedPayload";
};

/**
 * Sanitise and brand the payload so the type system prevents accidentally
 * bypassing sanitisation at the audit-write call site.
 */
export function toSanitisedPayload(
  record: unknown,
  redactKeys?: ReadonlySet<string>,
): SanitisedPayload {
  return sanitiseAuditPayload(record, redactKeys) as SanitisedPayload;
}
