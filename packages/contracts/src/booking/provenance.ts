import { z } from "zod";

/**
 * Booking provenance vocabulary — the string-backed set of supplier channels
 * whose offers may result in a real booking.
 *
 * Design: string-backed rather than a strict enum so a new certified-partner
 * channel can be added to SUPPLIER_PROVENANCES and deployed without a schema
 * migration.  The Prisma column is `VARCHAR(64)` and accepts any string; the
 * domain guard (isSupplierProvenance) enforces the approved set at write time.
 *
 * Vocabulary seeded with (WO-072):
 *   AMADEUS        — Amadeus GDS (flights)
 *   RAPIDAPI_HOTEL — RapidAPI Hotels channel
 *   RAPIDAPI_CAR   — RapidAPI Car Rental channel
 *   ILLUSTRATIVE   — AI-generated or placeholder inventory (never bookable)
 */

// ---------------------------------------------------------------------------
// Supplier set — the approved bookable provenance values
// ---------------------------------------------------------------------------

/** Provenance values that represent real, bookable supplier inventory. */
export const SUPPLIER_PROVENANCES = [
  "AMADEUS",
  "RAPIDAPI_HOTEL",
  "RAPIDAPI_CAR",
] as const;

export type SupplierProvenance = (typeof SUPPLIER_PROVENANCES)[number];

// ---------------------------------------------------------------------------
// Full booking provenance schema (supplier set + ILLUSTRATIVE)
// ---------------------------------------------------------------------------

export const BookingProvenanceSchema = z.enum([
  ...SUPPLIER_PROVENANCES,
  "ILLUSTRATIVE",
]);

export type BookingProvenance = z.infer<typeof BookingProvenanceSchema>;

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

const _supplierSet = new Set<string>(SUPPLIER_PROVENANCES);

/**
 * Returns true when `provenance` is in the approved supplier set.
 * An unknown or ILLUSTRATIVE value returns false — callers must reject the
 * offer before creating a PENDING booking.
 */
export function isSupplierProvenance(provenance: string): provenance is SupplierProvenance {
  return _supplierSet.has(provenance);
}

/**
 * Catch-all validator: accepts any non-empty string so future partner channels
 * that have been added to SUPPLIER_PROVENANCES in a newer deploy do not cause
 * a parse failure in a rolling-deploy window where old pods are still running.
 */
export const AnyProvenanceSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("Supplier channel identifier (see BookingProvenanceSchema for known values)");
