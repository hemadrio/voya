/**
 * WO-104 AC11: System integration tests for traveler envelope encryption.
 *
 * These tests validate the FULL booking-traveler security contract:
 *
 *   1. Booking creation writes AES-256-GCM encrypted values — a direct read
 *      of the persisted row returns ciphertext, never plaintext.
 *   2. The system role can decrypt for supplier submission.
 *   3. support_agent decryption is hard-denied with DecryptionDeniedError
 *      (httpStatus=403) and an immutable security audit event.
 *   4. Log output is masked — plaintext PII is never emitted even when a
 *      full booking object is logged.
 *   5. Key destruction makes all ciphertext for that subject permanently
 *      unrecoverable (cryptographic erasure / WO-102 prerequisite).
 *
 * Infrastructure: InMemoryEnvelopeCipher + in-memory mock DB (no AWS or
 * Docker required). The same contract must hold against KmsEnvelopeCipher
 * + real Postgres in the Docker Compose CI stage.
 *
 * See: docs/testing/test-strategy.md § "Integration tests"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import {
  BookingTravelerRepository,
  DecryptionDeniedError,
} from "../../src/repositories/BookingTravelerRepository.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import type {
  TravelerRow,
  TravelerPrismaClient,
  CallerContext,
} from "../../src/repositories/BookingTravelerRepository.js";
import type { SecurityEventInput } from "../../src/domain/SecurityEventWriter.js";

// ---------------------------------------------------------------------------
// In-memory persistence layer (simulates Postgres row storage)
// ---------------------------------------------------------------------------

function makePersistenceLayer(): TravelerPrismaClient & {
  _rows: TravelerRow[];
  /** Direct row access — simulates "raw SQL SELECT" bypassing the application */
  _rawSelect(bookingId: string): TravelerRow[];
} {
  const rows: TravelerRow[] = [];
  let idSeq = 0;

  return {
    _rows: rows,
    _rawSelect: (bookingId: string) => rows.filter((r) => r.bookingId === bookingId),

    bookingTraveler: {
      async create({ data }) {
        const row: TravelerRow = {
          id: `t-${++idSeq}`,
          bookingId: data.bookingId,
          givenName: data.givenName,
          familyName: data.familyName,
          email: data.email ?? null,
          encryptedDateOfBirth: data.encryptedDateOfBirth ?? null,
          encryptedDobIv: data.encryptedDobIv ?? null,
          encryptedPassportReference: data.encryptedPassportReference ?? null,
          encryptedPassportIv: data.encryptedPassportIv ?? null,
          wrappedDek: data.wrappedDek,
          dekKeyId: data.dekKeyId,
          encryptionContext: data.encryptionContext as Record<string, string>,
          createdAt: new Date(),
          purgeAfter: null,
          tripCompletedAt: null,
          legalHold: false,
        };
        rows.push(row);
        return row;
      },
      async findMany({ where }) {
        return rows.filter((r) => r.bookingId === where.bookingId);
      },
      async count({ where }) {
        return rows.filter((r) => r.bookingId === where.bookingId).length;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows) {
          if (row.bookingId !== where.bookingId) continue;
          row.tripCompletedAt = data.tripCompletedAt;
          row.purgeAfter = data.purgeAfter;
          count++;
        }
        return { count };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Security audit event capture
// ---------------------------------------------------------------------------

interface MockSecurityWriter {
  events: SecurityEventInput[];
  write: (e: SecurityEventInput) => Promise<void>;
}

function makeSecurityWriter(): MockSecurityWriter {
  const events: SecurityEventInput[] = [];
  return {
    events,
    write: vi.fn(async (event: SecurityEventInput) => {
      events.push(event);
    }),
  };
}

// ---------------------------------------------------------------------------
// Pino redaction helper
// ---------------------------------------------------------------------------

/**
 * Build a Pino logger with the same redaction paths configured in
 * packages/observability/src/logger.ts. Writes to the returned string array
 * so tests can inspect emitted output.
 */
function makeRedactingLogger(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];

  const dest = pino.destination({
    write(s: string) {
      lines.push(s);
    },
  });

  const logger = pino(
    {
      level: "debug",
      redact: {
        paths: [
          // Top-level sensitive keys
          "email",
          "password",
          "passwordHash",
          "dateOfBirth",
          "passportNumber",
          "passportReference",
          "authorization",
          "stripe-signature",
          // Nested request bodies
          "body.email",
          "body.password",
          "body.dateOfBirth",
          "body.passportReference",
          "req.headers.authorization",
          "req.headers['stripe-signature']",
          // Traveler arrays
          "travelers[*].dateOfBirth",
          "travelers[*].passportReference",
          "travelers[*].email",
          "passengers[*].dateOfBirth",
          "passengers[*].passportReference",
        ],
        censor: "[REDACTED]",
      },
    },
    dest,
  );

  return { logger, lines };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WO-104 AC11: Traveler encryption end-to-end security integration", () => {
  let cipher: InMemoryEnvelopeCipher;
  let db: ReturnType<typeof makePersistenceLayer>;
  let securityWriter: MockSecurityWriter;

  const BOOKING_ID = "bkg-integ-001";
  const TRAVELER = {
    givenName: "Alice",
    familyName: "IntegTest",
    email: "alice.integtest@synthetic.test",
    dateOfBirth: "1990-05-15",
    passportReference: "SYNTH1234567", // SYNTH_ prefix — obviously synthetic
  };

  beforeEach(async () => {
    cipher = new InMemoryEnvelopeCipher();
    db = makePersistenceLayer();
    securityWriter = makeSecurityWriter();

    // Seed: create a booking traveler
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    await repo.create({ bookingId: BOOKING_ID, ...TRAVELER });
  });

  // ── AC3: Direct row read returns ciphertext only ─────────────────────────

  it("AC3: raw SQL row contains ciphertext, not plaintext DOB or passport (AC3)", () => {
    const rawRows = db._rawSelect(BOOKING_ID);
    expect(rawRows).toHaveLength(1);

    const row = rawRows[0]!;

    // encryptedDateOfBirth is stored as bytes — it must NOT contain the plaintext
    const dobBytes = row.encryptedDateOfBirth;
    const passBytes = row.encryptedPassportReference;

    expect(dobBytes).not.toBeNull();
    expect(passBytes).not.toBeNull();

    // Compare hex to avoid encoding tricks
    const dobHex = dobBytes!.toString("hex");
    const passHex = passBytes!.toString("hex");
    const dobPlainHex = Buffer.from(TRAVELER.dateOfBirth, "utf8").toString("hex");
    const passPlainHex = Buffer.from(TRAVELER.passportReference, "utf8").toString("hex");

    expect(dobHex).not.toContain(dobPlainHex);
    expect(passHex).not.toContain(passPlainHex);

    // The IV columns must also be stored (AES-GCM nonce)
    expect(row.encryptedDobIv).not.toBeNull();
    expect(row.encryptedPassportIv).not.toBeNull();
  });

  it("AC3: raw row givenName/familyName are stored in cleartext (non-Restricted fields)", () => {
    const row = db._rawSelect(BOOKING_ID)[0]!;
    // Non-Restricted fields are NOT encrypted — they remain readable
    expect(row.givenName).toBe("Alice");
    expect(row.familyName).toBe("IntegTest");
  });

  // ── AC4/AC5: System role decrypts for supplier submission ────────────────

  it("AC4/AC5: system role decrypts traveler documents for supplier submission", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const systemCaller: CallerContext = { actorId: "booking-service", actorRole: "system" };

    const travelers = await repo.findByBookingId(BOOKING_ID, systemCaller);

    expect(travelers).toHaveLength(1);
    const t = travelers[0]!;
    expect(t.dateOfBirth).toBe(TRAVELER.dateOfBirth);
    expect(t.passportReference).toBe(TRAVELER.passportReference);

    // Allowed access does NOT write security events
    expect(securityWriter.events).toHaveLength(0);
  });

  it("AC4/AC5: traveler role (booking owner) can decrypt their own documents", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const travelerCaller: CallerContext = { actorId: "user-alice-001", actorRole: "traveler" };

    const travelers = await repo.findByBookingId(BOOKING_ID, travelerCaller);

    expect(travelers[0]!.passportReference).toBe(TRAVELER.passportReference);
    expect(securityWriter.events).toHaveLength(0);
  });

  // ── AC5: support_agent denied with 403 + audit event ────────────────────

  it("AC5: support_agent decryption is hard-denied with DecryptionDeniedError", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const agentCaller: CallerContext = { actorId: "agent-support-007", actorRole: "support_agent" };

    await expect(
      repo.findByBookingId(BOOKING_ID, agentCaller),
    ).rejects.toThrow(DecryptionDeniedError);
  });

  it("AC5: DecryptionDeniedError carries httpStatus=403, actorRole, and resourceId", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const agentCaller: CallerContext = { actorId: "agent-support-007", actorRole: "support_agent" };

    let caught: DecryptionDeniedError | undefined;
    try {
      await repo.findByBookingId(BOOKING_ID, agentCaller);
    } catch (err) {
      if (err instanceof DecryptionDeniedError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught!.httpStatus).toBe(403);
    expect(caught!.actorRole).toBe("support_agent");
    expect(caught!.resourceId).toBe(BOOKING_ID);
  });

  it("AC5: support_agent denial writes DENY security audit event with correct fields", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const agentCaller: CallerContext = { actorId: "agent-support-007", actorRole: "support_agent" };

    await repo.findByBookingId(BOOKING_ID, agentCaller).catch(() => {});

    expect(securityWriter.events).toHaveLength(1);
    const event = securityWriter.events[0]!;

    expect(event.decision).toBe("DENY");
    expect(event.actorId).toBe("agent-support-007");
    expect(event.actorRole).toBe("support_agent");
    expect(event.resourceId).toBe(BOOKING_ID);
    expect(event.operation).toBe("DECRYPT_IDENTITY_DOCUMENTS");
    // resourceType must identify the table for the audit trail
    expect(event.resourceType).toBe("booking_travelers");
  });

  it("AC5: security audit event is written BEFORE the error is thrown (compliance guarantee)", async () => {
    const writeOrder: string[] = [];

    const orderedWriter = {
      write: vi.fn(async (e: SecurityEventInput) => {
        writeOrder.push("audit-event-written");
      }),
    };

    const repo = new BookingTravelerRepository(db, cipher, orderedWriter);

    let errorThrown = false;
    try {
      await repo.findByBookingId(BOOKING_ID, {
        actorId: "agent-007",
        actorRole: "support_agent",
      });
    } catch {
      errorThrown = true;
      writeOrder.push("error-thrown");
    }

    expect(errorThrown).toBe(true);
    // Audit event must be FIRST in the sequence
    expect(writeOrder[0]).toBe("audit-event-written");
    expect(writeOrder[1]).toBe("error-thrown");
  });

  // ── AC5 (edge): multiple denials each produce an audit event ─────────────

  it("AC5: repeated support_agent calls each produce an independent audit event", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const agentCaller: CallerContext = { actorId: "agent-007", actorRole: "support_agent" };

    await repo.findByBookingId(BOOKING_ID, agentCaller).catch(() => {});
    await repo.findByBookingId(BOOKING_ID, agentCaller).catch(() => {});

    // Two independent denial attempts → two audit events
    expect(securityWriter.events).toHaveLength(2);
    expect(securityWriter.events.every((e) => e.decision === "DENY")).toBe(true);
  });

  // ── AC6: Log redaction masks PII in structured log output ─────────────────

  it("AC6: pino redaction masks dateOfBirth and passportReference at top level", () => {
    const { logger, lines } = makeRedactingLogger();

    logger.info({
      event: "traveler-lookup",
      bookingId: BOOKING_ID,
      dateOfBirth: "1990-05-15",
      passportReference: "SYNTH1234567",
      email: "alice.integtest@synthetic.test",
    });

    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]!);

    expect(entry.dateOfBirth).toBe("[REDACTED]");
    expect(entry.passportReference).toBe("[REDACTED]");
    expect(entry.email).toBe("[REDACTED]");
    // Non-PII fields pass through
    expect(entry.bookingId).toBe(BOOKING_ID);
  });

  it("AC6: pino redaction masks PII inside travelers array elements", () => {
    const { logger, lines } = makeRedactingLogger();

    logger.info({
      event: "booking-summary",
      travelers: [
        {
          givenName: "Alice",
          familyName: "Test",
          dateOfBirth: "1990-05-15",
          passportReference: "SYNTH1234567",
          email: "alice@synthetic.test",
        },
      ],
    });

    const entry = JSON.parse(lines[0]!);
    const traveler = entry.travelers[0];

    expect(traveler.dateOfBirth).toBe("[REDACTED]");
    expect(traveler.passportReference).toBe("[REDACTED]");
    expect(traveler.email).toBe("[REDACTED]");
    // Non-sensitive fields pass through
    expect(traveler.givenName).toBe("Alice");
  });

  it("AC6: authorization header is redacted in log output (prevents token leakage)", () => {
    const { logger, lines } = makeRedactingLogger();

    logger.info({
      req: {
        method: "GET",
        url: "/api/v1/bookings/123",
        headers: {
          authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
          "content-type": "application/json",
        },
      },
    });

    const entry = JSON.parse(lines[0]!);
    expect(entry.req.headers.authorization).toBe("[REDACTED]");
    expect(entry.req.headers["content-type"]).toBe("application/json");
  });

  // ── AC2: Cryptographic erasure (DEK destruction) ─────────────────────────

  it("AC2: key destruction makes ciphertext permanently unrecoverable", async () => {
    const repo = new BookingTravelerRepository(db, cipher, securityWriter);
    const subjectId = `${BOOKING_ID}:${TRAVELER.givenName}:${TRAVELER.familyName}`;

    // Confirm decryption works before erasure
    const before = await repo.findByBookingId(BOOKING_ID);
    expect(before[0]!.dateOfBirth).toBe(TRAVELER.dateOfBirth);

    // Perform cryptographic erasure (simulates WO-102 purge worker setting destroyed_at)
    cipher.destroySubjectKey(subjectId);

    // Ciphertext is now permanently unrecoverable
    await expect(repo.findByBookingId(BOOKING_ID)).rejects.toThrow(/destroyed/i);

    // The raw row still exists — the data is gone because the DEK is gone
    const rawRows = db._rawSelect(BOOKING_ID);
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]!.encryptedDateOfBirth).not.toBeNull(); // ciphertext still there, useless
  });

  // ── Full end-to-end booking flow ──────────────────────────────────────────

  it("end-to-end: multi-passenger booking with supplier decryption and agent denial", async () => {
    const multiRepo = new BookingTravelerRepository(db, cipher, securityWriter);
    const multiBookingId = "bkg-multi-e2e-001";

    // Step 1: Booking creation — dual-write all passengers
    await multiRepo.create({
      bookingId: multiBookingId,
      givenName: "Lead",
      familyName: "Traveler",
      email: "lead@synthetic.test",
      dateOfBirth: "1985-11-20",
      passportReference: "SYNTH_LP001",
    });
    await multiRepo.create({
      bookingId: multiBookingId,
      givenName: "Companion",
      familyName: "Traveler",
      email: "companion@synthetic.test",
      dateOfBirth: "1988-03-15",
      passportReference: "SYNTH_CP002",
    });

    // Step 2: Raw read returns ciphertext for all passengers
    const rawRows = db._rawSelect(multiBookingId);
    expect(rawRows).toHaveLength(2);
    for (const row of rawRows) {
      const passHex = row.encryptedPassportReference!.toString("hex");
      const passPlainPrefixHex = Buffer.from("SYNTH_", "utf8").toString("hex");
      // Even with SYNTH_ prefix the value is AES-GCM encrypted — not readable
      expect(passHex).not.toContain(passPlainPrefixHex);
    }

    // Step 3: System role (supplier adapter) decrypts for submission
    const systemResult = await multiRepo.findByBookingId(multiBookingId, {
      actorId: "booking-service-system",
      actorRole: "system",
    });
    expect(systemResult).toHaveLength(2);
    expect(systemResult.map((t) => t.passportReference).sort()).toEqual([
      "SYNTH_CP002",
      "SYNTH_LP001",
    ]);

    // Step 4: support_agent denied with audit trail
    await multiRepo.findByBookingId(multiBookingId, {
      actorId: "support-agent-42",
      actorRole: "support_agent",
    }).catch(() => {});

    // Security events: zero from steps 1–3, one from step 4
    expect(securityWriter.events).toHaveLength(1);
    expect(securityWriter.events[0]!.decision).toBe("DENY");
    expect(securityWriter.events[0]!.resourceId).toBe(multiBookingId);

    // Step 5: Count is consistent
    expect(await multiRepo.countByBookingId(multiBookingId)).toBe(2);
  });
});
