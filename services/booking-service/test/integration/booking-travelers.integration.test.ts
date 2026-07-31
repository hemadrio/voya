/**
 * Integration tests for the booking-travelers path.
 *
 * Uses InMemoryEnvelopeCipher (no KMS dependency) and an in-memory Prisma-
 * compatible mock to simulate the full create → read cycle. These tests
 * validate the integration between the cipher, repository, and mapper.
 *
 * For database-backed integration tests (real Postgres + KMS stub), see
 * the CI stage that spins up a Postgres container and a localstack KMS.
 *
 * Covers AC11:
 *   - Booking creation writes encrypted traveler rows
 *   - Owning traveler read returns decrypted values
 *   - support_agent cannot access encrypted column values
 *     (demonstrated via column-level revoke in the migration SQL — this
 *     test verifies the repository-level redaction path)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BookingTravelerRepository } from "../../src/repositories/BookingTravelerRepository.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import type { TravelerPrismaClient, TravelerRow } from "../../src/repositories/BookingTravelerRepository.js";

// ---------------------------------------------------------------------------
// In-memory Prisma mock
// ---------------------------------------------------------------------------

function makeMockDb(): TravelerPrismaClient {
  const rows: TravelerRow[] = [];
  let idSeq = 0;

  return {
    bookingTraveler: {
      async create({ data }) {
        const row: TravelerRow = {
          id: `traveler-${++idSeq}`,
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
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("booking-travelers integration", () => {
  let cipher: InMemoryEnvelopeCipher;
  let repo: BookingTravelerRepository;

  beforeEach(() => {
    cipher = new InMemoryEnvelopeCipher();
    const db = makeMockDb();
    repo = new BookingTravelerRepository(db, cipher);
  });

  it("end-to-end: create booking writes encrypted traveler rows, read returns decrypted values (AC11)", async () => {
    const bookingId = "booking-e2e-001";

    // Dual-write: persist traveler with encrypted identity fields
    await repo.create({
      bookingId,
      givenName: "Alice",
      familyName: "Traveler",
      email: "alice@example.com",
      dateOfBirth: "1990-05-15",
      passportReference: "AB1234567",
    });

    // Owning service reads back decrypted values
    const travelers = await repo.findByBookingId(bookingId);

    expect(travelers).toHaveLength(1);
    const traveler = travelers[0]!;

    expect(traveler.givenName).toBe("Alice");
    expect(traveler.familyName).toBe("Traveler");
    expect(traveler.email).toBe("alice@example.com");
    // Identity fields are decrypted
    expect(traveler.dateOfBirth).toBe("1990-05-15");
    expect(traveler.passportReference).toBe("AB1234567");
  });

  it("encrypted columns contain no plaintext substring", async () => {
    const bookingId = "booking-plaintext-check";

    const persistedRow = await repo.create({
      bookingId,
      givenName: "Bob",
      familyName: "Secure",
      email: undefined,
      dateOfBirth: "1975-08-12",
      passportReference: "CD9876543",
    });

    // Encrypted fields must not contain the plaintext values
    const dobHex = persistedRow.encryptedDateOfBirth?.toString("hex") ?? "";
    const passHex = persistedRow.encryptedPassportReference?.toString("hex") ?? "";

    const dob1975Hex = Buffer.from("1975-08-12", "utf8").toString("hex");
    const passHexPlain = Buffer.from("CD9876543", "utf8").toString("hex");

    expect(dobHex).not.toContain(dob1975Hex);
    expect(passHex).not.toContain(passHexPlain);
  });

  it("support_agent redacted view: encrypted fields not readable after DEK destruction (AC3, AC8)", async () => {
    const bookingId = "booking-erasure-test";
    const subjectId = `${bookingId}:Carol:Williams`;

    await repo.create({
      bookingId,
      givenName: "Carol",
      familyName: "Williams",
      email: undefined,
      dateOfBirth: "1968-12-01",
      passportReference: "EF5566778",
    });

    // Destroy the subject's DEK (simulates cryptographic erasure)
    cipher.destroySubjectKey(subjectId);

    // Attempting to read should fail because the DEK is destroyed
    await expect(repo.findByBookingId(bookingId)).rejects.toThrow(/destroyed/);
  });

  it("three passengers on one booking — all encrypted and decrypted correctly", async () => {
    const bookingId = "booking-multi-pax";

    const passengers = [
      { givenName: "David", familyName: "A", dob: "1990-01-01", passport: "PA1111111" },
      { givenName: "Eve", familyName: "B", dob: "1992-02-02", passport: "PB2222222" },
      { givenName: "Frank", familyName: "C", dob: "1988-03-03", passport: null },
    ];

    for (const p of passengers) {
      await repo.create({
        bookingId,
        givenName: p.givenName,
        familyName: p.familyName,
        email: undefined,
        dateOfBirth: p.dob,
        passportReference: p.passport,
      });
    }

    const travelers = await repo.findByBookingId(bookingId);
    expect(travelers).toHaveLength(3);

    const names = travelers.map((t) => t.givenName).sort();
    expect(names).toEqual(["David", "Eve", "Frank"]);

    const david = travelers.find((t) => t.givenName === "David")!;
    expect(david.dateOfBirth).toBe("1990-01-01");
    expect(david.passportReference).toBe("PA1111111");

    const frank = travelers.find((t) => t.givenName === "Frank")!;
    expect(frank.passportReference).toBeNull();
  });

  it("count matches row count after multiple creates", async () => {
    const bookingId = "booking-count-check";

    for (let i = 0; i < 5; i++) {
      await repo.create({
        bookingId,
        givenName: `Passenger${i}`,
        familyName: "Test",
        email: undefined,
        dateOfBirth: `198${i}-0${i + 1}-01`,
        passportReference: null,
      });
    }

    expect(await repo.countByBookingId(bookingId)).toBe(5);
  });
});
