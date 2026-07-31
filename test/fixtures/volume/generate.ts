/**
 * generate-volume-fixtures — produces tens of thousands of bookings and
 * audit rows spanning multiple months for partition routing and query plan
 * validation tests.
 *
 * Output files:
 *   test/fixtures/volume/bookings.jsonl
 *   test/fixtures/volume/audit-rows.jsonl
 *
 * Usage:
 *   tsx test/fixtures/volume/generate.ts [--count=5000] [--months=6]
 *
 * The generator deterministically uses a counter-based UUID so the same
 * invocation always produces the same output (reproducible CI fixtures).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const BOOKING_COUNT = parseInt(
  args.find((a) => a.startsWith("--count="))?.split("=")[1] ?? "10000",
  10,
);
const MONTH_SPAN = parseInt(
  args.find((a) => a.startsWith("--months="))?.split("=")[1] ?? "6",
  10,
);
const USERS_PER_MONTH = 500;

const OUT_DIR = path.join(__dirname);

// ---------------------------------------------------------------------------
// Deterministic UUID from an integer counter
// ---------------------------------------------------------------------------

function deterministicUuid(n: number): string {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(BigInt(n), 0);
  buf.writeBigUInt64BE(BigInt(n * 1000003), 8);
  // Set version (4) and variant (RFC 4122)
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function randomDateInMonth(year: number, month: number, seed: number): Date {
  // Deterministic day within the month
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = (seed % daysInMonth) + 1;
  const hour = seed % 24;
  const min = (seed * 7) % 60;
  return new Date(Date.UTC(year, month - 1, day, hour, min));
}

const STATUSES = ["CONFIRMED", "CONFIRMED", "CONFIRMED", "PENDING", "CANCELLED"] as const;
const ACTIONS = [
  "BOOKING_CREATED",
  "PAYMENT_INITIATED",
  "PAYMENT_CONFIRMED",
  "BOOKING_CONFIRMED",
] as const;

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function generate(): void {
  const bookingsPath = path.join(OUT_DIR, "bookings.jsonl");
  const auditPath = path.join(OUT_DIR, "audit-rows.jsonl");

  const bStream = fs.createWriteStream(bookingsPath);
  const aStream = fs.createWriteStream(auditPath);

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  let auditSeq = 0;

  for (let i = 0; i < BOOKING_COUNT; i++) {
    const bookingId = deterministicUuid(i);
    const userId = deterministicUuid(USERS_PER_MONTH + (i % (USERS_PER_MONTH * MONTH_SPAN)));

    // Spread bookings across MONTH_SPAN months
    const monthOffset = i % MONTH_SPAN;
    let targetMonth = currentMonth - monthOffset;
    let targetYear = currentYear;
    if (targetMonth < 1) {
      targetMonth += 12;
      targetYear -= 1;
    }

    const createdAt = randomDateInMonth(targetYear, targetMonth, i);
    const status = STATUSES[i % STATUSES.length]!;

    const booking = {
      id: bookingId,
      user_id: userId,
      booking_type: i % 3 === 0 ? "HOTEL" : i % 3 === 1 ? "FLIGHT" : "CAR",
      status,
      offer_id: deterministicUuid(i + 1_000_000),
      total_price: ((i % 1000) + 100) * 1.5,
      currency: "USD",
      contact_email: `user${userId.slice(0, 8)}@example.com`,
      idempotency_key: `idem-${bookingId}`,
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      expires_at: status === "PENDING"
        ? new Date(createdAt.getTime() + 30 * 60 * 1000).toISOString()
        : null,
    };

    bStream.write(JSON.stringify(booking) + "\n");

    // 4–5 audit rows per booking (one per state transition)
    const auditActionsForBooking = status === "CONFIRMED"
      ? ACTIONS
      : status === "CANCELLED"
      ? ["BOOKING_CREATED", "BOOKING_CANCELLED"] as const
      : ["BOOKING_CREATED"] as const;

    for (const action of auditActionsForBooking) {
      auditSeq++;
      const auditRow = {
        id: deterministicUuid(auditSeq + 20_000_000),
        booking_id: bookingId,
        action,
        previous_state: null,
        new_state: { action },
        changed_by: "system",
        timestamp: createdAt.toISOString(),
        actor_id: userId,
        actor_role: "system",
        resource_type: "booking",
        resource_id: bookingId,
        occurred_at: createdAt.toISOString(),
      };
      aStream.write(JSON.stringify(auditRow) + "\n");
    }
  }

  bStream.end(() => {
    console.log(`Written ${BOOKING_COUNT} bookings to ${bookingsPath}`);
  });
  aStream.end(() => {
    console.log(`Written ${auditSeq} audit rows to ${auditPath}`);
  });
}

generate();
