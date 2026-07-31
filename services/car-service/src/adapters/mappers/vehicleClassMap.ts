/**
 * vehicleClassMap — data-driven token-to-canonical-class mapping table.
 *
 * Provider vehicle descriptions arrive in free-form strings (e.g. "Economy
 * Compact", "Intermediate SUV or similar", "Luxury Sedan"). This module
 * normalises a description string, splits it into tokens, and looks each
 * token up in VEHICLE_CLASS_TOKENS.  The first token that matches determines
 * the canonical class.  No match → 'UNKNOWN'.
 *
 * HOW TO EXTEND:
 *   Add a new entry to VEHICLE_CLASS_TOKENS below. No adapter code changes
 *   are required — the mapper calls mapVehicleClass() which reads this table.
 *
 * CANONICAL CLASSES (from @travel/contracts CarClassSchema):
 *   ECONOMY   — small/city cars; lowest price tier
 *   COMPACT   — subcompact-to-compact; intermediate tier
 *   MIDSIZE   — mid-to-full-size sedans/hatchbacks; comfort tier
 *   PREMIUM   — luxury cars, SUVs, vans; top tier
 *   UNKNOWN   — provider description could not be mapped; never silently
 *               defaulted (BR-11 honesty constraint)
 */

/** Canonical car class including UNKNOWN for unmappable provider descriptions. */
export type CanonicalCarClass = 'ECONOMY' | 'COMPACT' | 'MIDSIZE' | 'PREMIUM' | 'UNKNOWN';

/**
 * Token → canonical class lookup table.
 *
 * Keys are normalised provider description tokens (lowercase, no punctuation).
 * Values are canonical CarClass values or 'UNKNOWN' (unreachable via this map,
 * since UNKNOWN is the fallback).
 *
 * Extend this table to add new provider-specific tokens without modifying
 * adapter or mapper logic.
 */
export const VEHICLE_CLASS_TOKENS: ReadonlyMap<string, CanonicalCarClass> = new Map([
  // ── ECONOMY ──────────────────────────────────────────────────────────────
  ['economy',       'ECONOMY'],
  ['mini',          'ECONOMY'],
  ['subcompact',    'ECONOMY'],
  ['micro',         'ECONOMY'],
  ['small',         'ECONOMY'],
  // ── COMPACT ──────────────────────────────────────────────────────────────
  ['compact',       'COMPACT'],
  ['intermediate',  'COMPACT'],
  ['standard',      'COMPACT'],
  // ── MIDSIZE ──────────────────────────────────────────────────────────────
  ['midsize',       'MIDSIZE'],
  ['midsized',      'MIDSIZE'],
  ['medium',        'MIDSIZE'],
  ['fullsize',      'MIDSIZE'],
  ['full',          'MIDSIZE'],
  ['regular',       'MIDSIZE'],
  // ── PREMIUM ──────────────────────────────────────────────────────────────
  ['premium',       'PREMIUM'],
  ['luxury',        'PREMIUM'],
  ['elite',         'PREMIUM'],
  ['executive',     'PREMIUM'],
  ['suv',           'PREMIUM'],
  ['van',           'PREMIUM'],
  ['minivan',       'PREMIUM'],
  ['convertible',   'PREMIUM'],
  ['sports',        'PREMIUM'],
  ['prestige',      'PREMIUM'],
]);

/**
 * Normalise a raw vehicle description string for token-based lookup.
 *
 * Steps:
 *   1. Lowercase
 *   2. Replace all non-alphanumeric characters (hyphens, slashes, commas,
 *      parentheses, etc.) with a single space
 *   3. Split on whitespace and discard empty tokens
 *
 * Examples:
 *   "Economy Compact"       → ["economy", "compact"]
 *   "Full-Size SUV"         → ["full", "size", "suv"]
 *   "Intermediate (or sim)" → ["intermediate", "or", "sim"]
 */
export function normaliseDescription(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Map a provider vehicle description to a canonical car class.
 *
 * Algorithm: first-token-match wins.
 *   1. Normalise the description (lowercase + strip punctuation → tokens).
 *   2. For each token in order, look up in VEHICLE_CLASS_TOKENS.
 *   3. Return the first matching class.
 *   4. Return 'UNKNOWN' when no token matches.
 *
 * 'UNKNOWN' is intentional and must never be silently replaced with a default
 * class (BR-11 honesty constraint).  Callers should emit a warn-level log for
 * every UNKNOWN result so the mapping table can be extended.
 */
export function mapVehicleClass(description: string): CanonicalCarClass {
  const tokens = normaliseDescription(description);
  for (const token of tokens) {
    const cls = VEHICLE_CLASS_TOKENS.get(token);
    if (cls !== undefined) return cls;
  }
  return 'UNKNOWN';
}
