/**
 * Role-seeded actor fixtures for RBAC tests (WO-014).
 *
 * Provides deterministic ActorContextPayload objects and User seed rows for
 * each of the three platform roles: traveler, support_agent, system.
 *
 * Use in adversarial cross-account tests to prove that:
 *   - traveler A cannot access traveler B's resources
 *   - support_agent can cancel bookings but cannot read identity documents
 *   - system actor cannot access user-profile endpoints
 *
 * All values are obviously synthetic (f0000... UUIDs, synth.example emails).
 * NEVER use real or production-derived data.
 */

import {
  SEED_IDS,
  SEED_EMAILS,
  SEED_REFERENCE_INSTANT,
} from "../identifiers.js";

// ---------------------------------------------------------------------------
// Actor context payloads (x-internal-actor header content after HMAC sign)
// ---------------------------------------------------------------------------

export interface SeedActorContext {
  sub: string;
  sid: string;
  roles: string[];
  jti: string;
  issuedAt: number;
}

const SEED_ISSUED_AT = Math.floor(SEED_REFERENCE_INSTANT.getTime() / 1000);

/** Alice — traveler, owns bookings f0000002-...-001 through -003. */
export const ACTOR_ALICE: SeedActorContext = {
  sub: SEED_IDS.user.alice,
  sid: "f0000000-sid-4000-8000-000000000001",
  roles: ["traveler"],
  jti: "jti-alice-001",
  issuedAt: SEED_ISSUED_AT,
};

/** Bob — traveler, has saved preferences, different resource set from Alice. */
export const ACTOR_BOB: SeedActorContext = {
  sub: SEED_IDS.user.bob,
  sid: "f0000000-sid-4000-8000-000000000002",
  roles: ["traveler"],
  jti: "jti-bob-001",
  issuedAt: SEED_ISSUED_AT,
};

/** Dana — support_agent. Can view/cancel bookings. Cannot read identity docs (BR-10). */
export const ACTOR_DANA_SUPPORT: SeedActorContext = {
  sub: SEED_IDS.user.danaSupportAgent,
  sid: "f0000000-sid-4000-8000-000000000004",
  roles: ["support_agent"],
  jti: "jti-dana-001",
  issuedAt: SEED_ISSUED_AT,
};

/** System — background job identity. Scoped to its own tables only. */
export const ACTOR_SYSTEM: SeedActorContext = {
  sub: SEED_IDS.user.systemActor,
  sid: "f0000000-sid-4000-8000-000000000005",
  roles: ["system"],
  jti: "jti-system-001",
  issuedAt: SEED_ISSUED_AT,
};

// ---------------------------------------------------------------------------
// User seed rows (matches Prisma UserSeed shape from user.ts)
// ---------------------------------------------------------------------------

const SYNTHETIC_PASSWORD_HASH =
  "$2b$12$SYNTHETIC000000000000000000000000000000000000000000000";

export interface RbacUserSeed {
  id: string;
  email: string;
  passwordHash: string;
  role: "traveler" | "support_agent" | "system";
  createdAt: Date;
  updatedAt: Date;
  failedAttemptCount: number;
  lockedUntil: Date | null;
  classification: "RESTRICTED";
  erasureRequestedAt: Date | null;
  purgeAfter: Date | null;
}

function makeRbacUser(overrides: Partial<RbacUserSeed> & Pick<RbacUserSeed, 'id' | 'email' | 'role'>): RbacUserSeed {
  return {
    id: overrides.id,
    email: overrides.email,
    passwordHash: SYNTHETIC_PASSWORD_HASH,
    role: overrides.role,
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

/** Seed row for Alice (traveler). */
export const SEED_USER_ALICE_TRAVELER: RbacUserSeed = makeRbacUser({
  id: SEED_IDS.user.alice,
  email: SEED_EMAILS.alice,
  role: "traveler",
});

/** Seed row for Bob (traveler). */
export const SEED_USER_BOB_TRAVELER: RbacUserSeed = makeRbacUser({
  id: SEED_IDS.user.bob,
  email: SEED_EMAILS.bob,
  role: "traveler",
});

/** Seed row for Dana (support_agent). */
export const SEED_USER_DANA_SUPPORT_AGENT: RbacUserSeed = makeRbacUser({
  id: SEED_IDS.user.danaSupportAgent,
  email: SEED_EMAILS.danaSupportAgent,
  role: "support_agent",
});

/** Seed row for System actor. */
export const SEED_USER_SYSTEM: RbacUserSeed = makeRbacUser({
  id: SEED_IDS.user.systemActor,
  email: SEED_EMAILS.systemActor,
  role: "system",
});

/** All four RBAC seed users in insertion order. */
export const ALL_RBAC_USERS: RbacUserSeed[] = [
  SEED_USER_ALICE_TRAVELER,
  SEED_USER_BOB_TRAVELER,
  SEED_USER_DANA_SUPPORT_AGENT,
  SEED_USER_SYSTEM,
];
