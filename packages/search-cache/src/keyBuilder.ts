import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * ISO 8601 date-only pattern (YYYY-MM-DD or YYYY-MM-DDT...).
 * We strip the time component so "2024-03-15" and "2024-03-15T00:00:00Z"
 * produce the same key.
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T|$)/;

/**
 * Normalise a single leaf value:
 *  - Strings: trimmed; if date-shaped → keep YYYY-MM-DD only; otherwise UPPERCASE
 *  - Arrays of strings: each element normalised + array sorted
 *  - Other arrays: each element normalised recursively (order preserved)
 *  - Objects: recursed via canonicalObject
 *  - Primitives: unchanged
 */
function normaliseValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_PATTERN.test(trimmed)) {
      // Normalise to YYYY-MM-DD, stripping any time/zone component
      return trimmed.slice(0, 10);
    }
    // Upper-case airport codes, location codes, and any other string param
    return trimmed.toUpperCase();
  }

  if (Array.isArray(value)) {
    const normalised = value.map(normaliseValue);
    // Sort arrays of strings so ["LAX","JFK"] and ["JFK","LAX"] produce the same key
    if (normalised.every(v => typeof v === 'string')) {
      return (normalised as string[]).slice().sort();
    }
    return normalised;
  }

  if (value !== null && typeof value === 'object') {
    return canonicalObject(value as Record<string, unknown>);
  }

  return value;
}

/** Recursively sort object keys and normalise values. */
function canonicalObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map(k => [k, normaliseValue(obj[k as keyof typeof obj])]),
  );
}

/**
 * Produces a deterministic JSON string from a search-params object.
 *
 * Normalisation rules (documented per acceptance criterion 2):
 *  - Object keys sorted recursively (alphabetically)
 *  - String values trimmed; date-shaped strings → YYYY-MM-DD
 *  - All other string values uppercased (covers IATA codes, location codes)
 *  - String arrays sorted so order does not affect the key
 *
 * Two semantically identical parameter objects always produce the same string.
 */
export function canonicalJson(params: Record<string, unknown>): string {
  return JSON.stringify(canonicalObject(params));
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of the canonical JSON for the given params. */
export function buildKeyHash(params: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(params)).digest('hex');
}

/** Cache entry key: `search:{category}:{sha256hex}` */
export function buildKey(category: string, hash: string): string {
  return `search:${category}:${hash}`;
}

/** Single-flight lock key: `search:lock:{category}:{sha256hex}` */
export function buildLockKey(category: string, hash: string): string {
  return `search:lock:${category}:${hash}`;
}
