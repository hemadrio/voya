/**
 * seed-synthetic-travelers — anonymised non-production seeder.
 *
 * Generates synthetic traveler data for staging and CI environments.
 * No production personal data is ever used.
 *
 * Usage:
 *   SEED_COUNT=50 DATABASE_URL=postgres://... CMK_ARN=arn:aws:kms:... \
 *   tsx scripts/seed-synthetic-travelers.ts
 *
 * For CI without KMS, set USE_IN_MEMORY_CIPHER=true to use the test double.
 */

import { PrismaClient } from "@prisma/client";
import { KmsEnvelopeCipher, InMemoryEnvelopeCipher } from "@travel/crypto";
import type { EnvelopeCipher } from "@travel/crypto";
import { BookingTravelerRepository } from "../services/booking-service/src/repositories/BookingTravelerRepository.js";

// ---------------------------------------------------------------------------
// Synthetic data generators
// ---------------------------------------------------------------------------

const GIVEN_NAMES = [
  "Alex", "Jordan", "Taylor", "Morgan", "Casey",
  "Riley", "Jamie", "Avery", "Reese", "Quinn",
  "Sage", "Blake", "Skyler", "Rowan", "Parker",
];

const FAMILY_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones",
  "Garcia", "Miller", "Davis", "Wilson", "Anderson",
  "Thomas", "Martin", "Jackson", "White", "Harris",
];

function pick<T>(arr: T[]): T {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index] ?? arr[0]!;
}

function syntheticDob(): string {
  const year = 1960 + Math.floor(Math.random() * 45);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function syntheticPassport(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "0123456789";
  let result = "";
  for (let i = 0; i < 2; i++) result += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 7; i++) result += digits[Math.floor(Math.random() * digits.length)];
  return result;
}

function syntheticEmail(givenName: string, familyName: string, index: number): string {
  return `${givenName.toLowerCase()}.${familyName.toLowerCase()}${index}@synthetic.example.com`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SEED_COUNT = parseInt(process.env["SEED_COUNT"] ?? "20", 10);
const CMK_ARN = process.env["CMK_ARN"] ?? "";
const USE_IN_MEMORY = process.env["USE_IN_MEMORY_CIPHER"] === "true";

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    console.error("[seed-synthetic] ERROR: This script must NOT run in production.");
    process.exit(1);
  }

  console.log(
    `[seed-synthetic] Seeding ${SEED_COUNT} synthetic travelers (cipher=${
      USE_IN_MEMORY ? "in-memory" : "kms"
    })`,
  );

  let cipher: EnvelopeCipher;

  if (USE_IN_MEMORY) {
    cipher = new InMemoryEnvelopeCipher();
  } else {
    if (!CMK_ARN) {
      console.error("[seed-synthetic] CMK_ARN is required when USE_IN_MEMORY_CIPHER is not set");
      process.exit(1);
    }
    cipher = new KmsEnvelopeCipher({ cmkArn: CMK_ARN });
  }

  const prisma = new PrismaClient();

  const db = {
    bookingTraveler: {
      create: (args: Parameters<typeof prisma.bookingTraveler.create>[0]) =>
        prisma.bookingTraveler.create(args),
      findMany: (args: Parameters<typeof prisma.bookingTraveler.findMany>[0]) =>
        prisma.bookingTraveler.findMany(args),
      count: (args: Parameters<typeof prisma.bookingTraveler.count>[0]) =>
        prisma.bookingTraveler.count(args),
    },
  };

  const repo = new BookingTravelerRepository(db as never, cipher);

  // Fetch or create synthetic bookings to attach travelers to
  const bookings = await prisma.booking.findMany({
    take: Math.ceil(SEED_COUNT / 3),
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (bookings.length === 0) {
    console.warn("[seed-synthetic] No bookings found — create bookings first");
    process.exit(0);
  }

  let seeded = 0;

  try {
    for (let i = 0; i < SEED_COUNT && seeded < SEED_COUNT; i++) {
      const booking = bookings[i % bookings.length];
      if (!booking) continue;

      const givenName = pick(GIVEN_NAMES);
      const familyName = pick(FAMILY_NAMES);

      await repo.create({
        bookingId: booking.id,
        givenName,
        familyName,
        email: syntheticEmail(givenName, familyName, i),
        dateOfBirth: syntheticDob(),
        passportReference: Math.random() > 0.2 ? syntheticPassport() : null,
      });

      seeded++;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`[seed-synthetic] Done — seeded ${seeded} synthetic traveler rows.`);
}

main().catch((err) => {
  console.error("[seed-synthetic] Fatal error:", err);
  process.exit(1);
});
