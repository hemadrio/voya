/**
 * User entity seed factories.
 *
 * Returns plain objects suitable for Prisma createMany / upsert. All values
 * are obviously synthetic: emails use the @synth.example domain, password
 * hashes are the bcrypt hash of the literal string "Synth1234!" (computed
 * offline — never a real user credential), and identity fields follow the
 * SYNTH- prefix convention.
 *
 * Determinism guarantee: calling makeUser(SEED_IDS.user.alice) twice with
 * no overrides always returns the same object.
 */

import { SEED_IDS, SEED_EMAILS, SEED_REFERENCE_INSTANT, refDate, RETENTION } from "../identifiers.js";

/** Bcrypt hash of "Synth1234!" — computed offline, obviously synthetic. */
const SYNTHETIC_PASSWORD_HASH =
  "$2b$12$SYNTHETIC000000000000000000000000000000000000000000000";

export interface UserSeed {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  failedAttemptCount: number;
  lockedUntil: Date | null;
  classification: "RESTRICTED";
  erasureRequestedAt: Date | null;
  purgeAfter: Date | null;
}

export function makeUser(overrides: Partial<UserSeed> = {}): UserSeed {
  return {
    id: SEED_IDS.user.alice,
    email: SEED_EMAILS.alice,
    passwordHash: SYNTHETIC_PASSWORD_HASH,
    role: "traveler",
    createdAt: SEED_REFERENCE_INSTANT,
    updatedAt: SEED_REFERENCE_INSTANT,
    failedAttemptCount: 0,
    lockedUntil: null,
    classification: "RESTRICTED",
    erasureRequestedAt: null,
    purgeAfter: null,
    ...overrides,
  };
}

/** The three seed personas — consumed by prisma/seed.ts. */
export const SEED_USERS: UserSeed[] = [
  makeUser({
    id: SEED_IDS.user.alice,
    email: SEED_EMAILS.alice,
    role: "traveler",
    createdAt: SEED_REFERENCE_INSTANT,
    updatedAt: SEED_REFERENCE_INSTANT,
  }),
  makeUser({
    id: SEED_IDS.user.bob,
    email: SEED_EMAILS.bob,
    role: "traveler",
    createdAt: refDate(60 * 1000),
    updatedAt: refDate(60 * 1000),
  }),
  makeUser({
    id: SEED_IDS.user.charlie,
    email: SEED_EMAILS.charlie,
    role: "traveler",
    createdAt: refDate(120 * 1000),
    updatedAt: refDate(120 * 1000),
    // Charlie has requested erasure — purgeAfter is populated.
    erasureRequestedAt: refDate(7 * 24 * 60 * 60 * 1000),
    purgeAfter: RETENTION.session,
  }),
];
