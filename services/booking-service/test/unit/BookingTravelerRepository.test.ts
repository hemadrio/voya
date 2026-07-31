/**
 * Unit tests for BookingTravelerRepository.
 *
 * Uses InMemoryEnvelopeCipher and a Prisma mock to verify:
 *   - create() encrypts fields before persistence
 *   - create() maps PassengerInfo to BookingTraveler correctly
 *   - create() handles null passportReference correctly
 *   - findByBookingId() decrypts and returns readable values
 *   - countByBookingId() delegates to the Prisma client
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingTravelerRepository } from "../../src/repositories/BookingTravelerRepository.js";
import { InMemoryEnvelopeCipher } from "@travel/crypto";
import type { TravelerRow, TravelerPrismaClient } from "../../src/repositories/BookingTravelerRepository.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDb(): TravelerPrismaClient & {
  _rows: TravelerRow[];
} {
  const rows: TravelerRow[] = [];

  return {
    _rows: rows,
    bookingTraveler: {
      async create({ data }) {
        const row: TravelerRow = {
          id: `id-${rows.length}`,
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

describe("BookingTravelerRepository", () => {
  let cipher: InMemoryEnvelopeCipher;
  let db: ReturnType<typeof makeMockDb>;
  let repo: BookingTravelerRepository;

  beforeEach(() => {
    cipher = new InMemoryEnvelopeCipher();
    db = makeMockDb();
    repo = new BookingTravelerRepository(db as never, cipher);
  });

  it("create() persists encrypted fields — plaintext not stored in ciphertext", async () => {
    const row = await repo.create({
      bookingId: "booking-001",
      givenName: "Alice",
      familyName: "Smith",
      email: "alice@example.com",
      dateOfBirth: "1990-05-15",
      passportReference: "AB1234567",
    });

    expect(row.encryptedDateOfBirth).not.toBeNull();
    expect(row.encryptedPassportReference).not.toBeNull();

    // Plaintext must not appear verbatim in the encrypted columns
    expect(row.encryptedDateOfBirth!.toString("utf8")).not.toContain("1990-05-15");
    expect(row.encryptedPassportReference!.toString("utf8")).not.toContain("AB1234567");
  });

  it("create() stores null encrypted columns when passportReference is null", async () => {
    const row = await repo.create({
      bookingId: "booking-002",
      givenName: "Bob",
      familyName: "Jones",
      email: undefined,
      dateOfBirth: "1985-11-22",
      passportReference: null,
    });

    expect(row.encryptedDateOfBirth).not.toBeNull();
    expect(row.encryptedPassportReference).toBeNull();
    expect(row.encryptedPassportIv).toBeNull();
  });

  it("findByBookingId() decrypts and returns readable values", async () => {
    await repo.create({
      bookingId: "booking-003",
      givenName: "Carol",
      familyName: "Williams",
      email: "carol@example.com",
      dateOfBirth: "1978-03-08",
      passportReference: "CD9876543",
    });

    const travelers = await repo.findByBookingId("booking-003");

    expect(travelers).toHaveLength(1);
    expect(travelers[0]!.givenName).toBe("Carol");
    expect(travelers[0]!.familyName).toBe("Williams");
    expect(travelers[0]!.email).toBe("carol@example.com");
    expect(travelers[0]!.dateOfBirth).toBe("1978-03-08");
    expect(travelers[0]!.passportReference).toBe("CD9876543");
  });

  it("findByBookingId() returns null for missing passport when not encrypted", async () => {
    await repo.create({
      bookingId: "booking-004",
      givenName: "David",
      familyName: "Brown",
      email: undefined,
      dateOfBirth: "1992-07-30",
      passportReference: null,
    });

    const travelers = await repo.findByBookingId("booking-004");
    expect(travelers[0]!.passportReference).toBeNull();
  });

  it("countByBookingId() returns correct count", async () => {
    await repo.create({
      bookingId: "booking-005",
      givenName: "Eve",
      familyName: "Taylor",
      email: undefined,
      dateOfBirth: "2001-01-01",
      passportReference: null,
    });
    await repo.create({
      bookingId: "booking-005",
      givenName: "Frank",
      familyName: "Davis",
      email: undefined,
      dateOfBirth: "1999-09-09",
      passportReference: "EF1122334",
    });

    const count = await repo.countByBookingId("booking-005");
    expect(count).toBe(2);
  });

  it("findByBookingId() returns only travelers for the requested booking", async () => {
    await repo.create({
      bookingId: "booking-006",
      givenName: "Grace",
      familyName: "Lee",
      email: undefined,
      dateOfBirth: "1988-04-12",
      passportReference: null,
    });
    await repo.create({
      bookingId: "booking-007",
      givenName: "Henry",
      familyName: "Clark",
      email: undefined,
      dateOfBirth: "1991-08-25",
      passportReference: null,
    });

    const b6 = await repo.findByBookingId("booking-006");
    const b7 = await repo.findByBookingId("booking-007");

    expect(b6).toHaveLength(1);
    expect(b6[0]!.givenName).toBe("Grace");
    expect(b7).toHaveLength(1);
    expect(b7[0]!.givenName).toBe("Henry");
  });
});
