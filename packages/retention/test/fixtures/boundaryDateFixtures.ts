/**
 * Boundary-date fixture generator for retention purge integration tests.
 *
 * Produces rows with purge_after set to:
 *   - exactly NOW (boundary: should be purged — purge_after <= now)
 *   - 1 second in the PAST (should be purged)
 *   - 1 second in the FUTURE (must NOT be purged)
 *   - null (no purge deadline yet — must NOT be purged)
 *
 * This generator produces in-memory objects representing the rows; a
 * real-DB integration test can hydrate them into Postgres directly.
 */

import { randomUUID } from "node:crypto";

export interface BoundaryRow {
  id: string;
  purge_after: Date | null;
  /** WO-102: When true, the purge worker must skip this row even if purge_after is due. */
  legal_hold?: boolean;
  /** Expected outcome after a purge run with dryRun=false. */
  expectedOutcome: "purged" | "retained";
  label: string;
}

export interface ErasureRow extends BoundaryRow {
  subject_id: string;
  wrapped_dek: Buffer | null;
  dek_key_id: string | null;
  booking_id: string;
}

/**
 * Generate boundary rows for a scalar personal-data table (physical_delete).
 */
export function generatePhysicalDeleteFixtures(now: Date): BoundaryRow[] {
  const past = new Date(now.getTime() - 1_000);
  const future = new Date(now.getTime() + 1_000);

  return [
    {
      id: randomUUID(),
      purge_after: now,
      expectedOutcome: "purged",
      label: "boundary: purge_after == now (should purge)",
    },
    {
      id: randomUUID(),
      purge_after: past,
      expectedOutcome: "purged",
      label: "expired: purge_after 1s in the past (should purge)",
    },
    {
      id: randomUUID(),
      purge_after: future,
      expectedOutcome: "retained",
      label: "future: purge_after 1s in the future (must retain)",
    },
    {
      id: randomUUID(),
      purge_after: null,
      expectedOutcome: "retained",
      label: "null: no purge deadline (must retain)",
    },
    // WO-102: Legal hold — row is due for purge but must be skipped.
    {
      id: randomUUID(),
      purge_after: past,
      legal_hold: true,
      expectedOutcome: "retained",
      label: "legal_hold: purge_after due but legal_hold=true (must retain)",
    },
  ];
}

/**
 * Generate boundary rows for a crypto-erasure table (booking_travelers).
 */
export function generateCryptoEraseFixtures(now: Date): ErasureRow[] {
  const past = new Date(now.getTime() - 1_000);
  const future = new Date(now.getTime() + 1_000);
  const fakeWrappedDek = Buffer.from("fake-dek-material");

  return [
    {
      id: randomUUID(),
      subject_id: randomUUID(),
      wrapped_dek: fakeWrappedDek,
      dek_key_id: "kms-key-1",
      booking_id: randomUUID(),
      purge_after: now,
      expectedOutcome: "purged",
      label: "boundary: crypto-erase at exactly now",
    },
    {
      id: randomUUID(),
      subject_id: randomUUID(),
      wrapped_dek: fakeWrappedDek,
      dek_key_id: "kms-key-1",
      booking_id: randomUUID(),
      purge_after: past,
      expectedOutcome: "purged",
      label: "expired: crypto-erase 1s in the past",
    },
    {
      id: randomUUID(),
      subject_id: randomUUID(),
      wrapped_dek: fakeWrappedDek,
      dek_key_id: "kms-key-1",
      booking_id: randomUUID(),
      purge_after: future,
      expectedOutcome: "retained",
      label: "future: must NOT crypto-erase",
    },
    {
      id: randomUUID(),
      subject_id: randomUUID(),
      wrapped_dek: null, // already erased — idempotent
      dek_key_id: null,
      booking_id: randomUUID(),
      purge_after: past,
      expectedOutcome: "purged",
      label: "already-erased: idempotent (wrapped_dek already null)",
    },
    // WO-102: Legal hold — traveler record is due for crypto-erasure but legal_hold=true.
    {
      id: randomUUID(),
      subject_id: randomUUID(),
      wrapped_dek: fakeWrappedDek,
      dek_key_id: "kms-key-1",
      booking_id: randomUUID(),
      purge_after: past,
      legal_hold: true,
      expectedOutcome: "retained",
      label: "legal_hold: crypto-erase due but legal_hold=true (must retain)",
    },
  ];
}

/**
 * Generate all fixture rows for every register category.
 * Returns a map: tableName → array of boundary rows.
 */
export function generateAllFixtures(now: Date): Map<string, BoundaryRow[]> {
  const fixtures = new Map<string, BoundaryRow[]>();

  const physicalTables = [
    "users",
    "sessions",
    "one_time_tokens",
    "bookings",
    "itineraries",
    "travel_preferences",
    "conversation_history",
  ];

  for (const table of physicalTables) {
    fixtures.set(table, generatePhysicalDeleteFixtures(now));
  }

  // Crypto-erase table
  fixtures.set("booking_travelers", generateCryptoEraseFixtures(now));

  // Audit table — no purge rows (excluded from erasure)
  fixtures.set("booking_audit_log", [
    {
      id: randomUUID(),
      purge_after: new Date(now.getTime() - 1_000), // expired but excluded
      expectedOutcome: "retained",
      label: "audit: excluded from erasure — must always retain",
    },
  ]);

  return fixtures;
}
