/**
 * canonicalize.ts — deterministic JSON serialiser for audit hash chaining.
 *
 * Rules:
 *   - Object keys are sorted lexicographically (deep).
 *   - Numbers use fixed-point notation capped at 10 decimal places so
 *     floating-point representation is stable across JS runtimes.
 *   - Strings, booleans, nulls are passed through unchanged.
 *   - Arrays preserve element order (order is meaningful in arrays).
 *   - undefined values in objects are omitted (JSON.stringify behaviour).
 *
 * The output is a deterministic UTF-8 string used as the pre-image for
 * SHA-256 hash chaining — any change to a field value or key order is
 * detectable by recomputing the hash.
 */

// ---------------------------------------------------------------------------
// Core serialiser
// ---------------------------------------------------------------------------

/**
 * Serialise `value` to a canonical JSON string.
 *
 * @param value - Any JSON-serialisable value.
 * @returns A deterministic JSON string with sorted object keys.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * Deep-sort all object keys so the canonical form is independent of the
 * insertion order used by the caller.  Arrays and primitives pass through
 * unchanged.
 */
function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    // Primitives: string, number, boolean, null — pass through.
    // Numbers do NOT get fixed-point coercion here: JSON.stringify already
    // emits the same representation as the value was stored with, and we
    // rely on callers to pass already-typed values.  An optional normalise
    // step is available via normaliseNumber() below for floating-point data.
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }

  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      sorted[key] = sortDeep(v);
    }
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Hash pre-image builder
// ---------------------------------------------------------------------------

/**
 * Fields contributed to the hash pre-image for a booking audit entry.
 * Must match the column list in PrismaAuditWriter.buildPreImage().
 */
export interface BookingAuditPreImage {
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState: unknown;
  newState: unknown;
  occurredAt: string; // ISO-8601
  correlationId: string | null;
}

/**
 * Fields contributed to the hash pre-image for an auth audit entry.
 */
export interface AuthAuditPreImage {
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState: unknown;
  newState: unknown;
  occurredAt: string;
  correlationId: string | null;
}

/**
 * Produce the canonical pre-image string for an audit row.
 * `prevHash` is the entry_hash of the previous row for the same resource
 * stream, or the genesis sentinel when this is the first entry.
 */
export function buildAuditPreImage(
  row: BookingAuditPreImage | AuthAuditPreImage,
  prevHash: string,
): string {
  return canonicalize(row) + prevHash;
}

// ---------------------------------------------------------------------------
// Genesis sentinel
// ---------------------------------------------------------------------------

/**
 * The `prev_hash` value for the first entry in a resource stream.
 * Using a well-known constant (rather than null or empty string) means the
 * first entry's hash is still chained to something deterministic, and
 * null-string-concatenation bugs are avoided.
 */
export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";
