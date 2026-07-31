/**
 * Test factories for identity domain objects.
 *
 * Produces deterministic in-memory objects suitable for unit tests and
 * integration seeding.  All IDs, timestamps, and hashes are hard-coded so
 * tests do not depend on random values and remain reproducible across runs.
 *
 * Usage:
 *   const user = makeAdminUser();               // admin, active
 *   const user = makeVerifiedUser();             // traveler, active, email verified
 *   const user = makeUnverifiedUser();           // traveler, pending, no email_verified_at
 *   const user = makeLockedUser();               // traveler, active, locked credential
 */

import type { UserEntity, UserStatus } from '../../src/domain/UserRepository.js';
import type { CredentialEntity, CredentialWithSecret } from '../../src/domain/CredentialRepository.js';
import type { SessionEntity } from '../../src/domain/IdentitySessionRepository.js';
import type { RoleEntity, UserRoleAssignment } from '../../src/domain/RoleRepository.js';

// ---------------------------------------------------------------------------
// Stable fixture IDs
// ---------------------------------------------------------------------------

export const FIXTURE_IDS = {
  adminUserId:      '00000000-0000-4000-a000-000000000001',
  verifiedUserId:   '00000000-0000-4000-a000-000000000002',
  unverifiedUserId: '00000000-0000-4000-a000-000000000003',
  lockedUserId:     '00000000-0000-4000-a000-000000000004',

  adminRoleId:     '00000000-0000-4000-b000-000000000001',
  travelerRoleId:  '00000000-0000-4000-b000-000000000002',

  adminCredId:    '00000000-0000-4000-c000-000000000001',
  verifiedCredId: '00000000-0000-4000-c000-000000000002',
  lockedCredId:   '00000000-0000-4000-c000-000000000004',

  activeSessionId: '00000000-0000-4000-d000-000000000001',
} as const;

// ---------------------------------------------------------------------------
// User factories
// ---------------------------------------------------------------------------

function baseUser(overrides: Partial<UserEntity> & { id: string; email: string; status: UserStatus }): UserEntity {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    emailVerifiedAt: null,
    displayName: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeAdminUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return baseUser({
    id: FIXTURE_IDS.adminUserId,
    email: 'admin@example.com',
    displayName: 'Platform Admin',
    status: 'active',
    emailVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

export function makeVerifiedUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return baseUser({
    id: FIXTURE_IDS.verifiedUserId,
    email: 'alice@example.com',
    displayName: 'Alice',
    status: 'active',
    emailVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

export function makeUnverifiedUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return baseUser({
    id: FIXTURE_IDS.unverifiedUserId,
    email: 'bob@example.com',
    displayName: 'Bob',
    status: 'pending',
    emailVerifiedAt: null,
    ...overrides,
  });
}

export function makeLockedUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return baseUser({
    id: FIXTURE_IDS.lockedUserId,
    email: 'charlie@example.com',
    displayName: 'Charlie',
    status: 'active',
    emailVerifiedAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Credential factories
// ---------------------------------------------------------------------------

function baseCredential(overrides: Partial<CredentialEntity> & { id: string; userId: string }): CredentialEntity {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    type: 'password',
    hashAlgorithm: 'argon2id',
    failedAttemptCount: 0,
    lockedUntil: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeAdminCredential(): CredentialEntity {
  return baseCredential({
    id: FIXTURE_IDS.adminCredId,
    userId: FIXTURE_IDS.adminUserId,
  });
}

export function makeVerifiedCredential(): CredentialEntity {
  return baseCredential({
    id: FIXTURE_IDS.verifiedCredId,
    userId: FIXTURE_IDS.verifiedUserId,
  });
}

export function makeLockedCredential(): CredentialEntity {
  return baseCredential({
    id: FIXTURE_IDS.lockedCredId,
    userId: FIXTURE_IDS.lockedUserId,
    failedAttemptCount: 5,
    lockedUntil: new Date('2099-12-31T23:59:59.000Z'),
  });
}

/** Credential with secretHash exposed — only for verification test scenarios. */
export function makeCredentialWithSecret(userId: string, secretHash = '$argon2id$v=19$m=65536,t=3,p=4$fakeSalt$fakeHash'): CredentialWithSecret {
  const base = baseCredential({ id: '00000000-0000-4000-c000-000000000099', userId });
  return { ...base, secretHash };
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

export function makeActiveSession(overrides: Partial<SessionEntity> = {}): SessionEntity {
  const now = new Date('2024-01-01T00:00:00.000Z');
  const expiresAt = new Date('2024-01-08T00:00:00.000Z');
  return {
    id: FIXTURE_IDS.activeSessionId,
    userId: FIXTURE_IDS.verifiedUserId,
    refreshTokenHash: 'sha256-abc123-placeholder-hash',
    userAgent: 'TestBrowser/1.0',
    ipAddress: '127.0.0.1',
    issuedAt: now,
    expiresAt,
    revokedAt: null,
    rotatedFromSessionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Role factories
// ---------------------------------------------------------------------------

export function makeAdminRole(overrides: Partial<RoleEntity> = {}): RoleEntity {
  return {
    id: FIXTURE_IDS.adminRoleId,
    name: 'admin',
    description: 'Platform administrator with full access',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function makeTravelerRole(overrides: Partial<RoleEntity> = {}): RoleEntity {
  return {
    id: FIXTURE_IDS.travelerRoleId,
    name: 'traveler',
    description: 'Standard authenticated traveler',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function makeAdminRoleAssignment(): UserRoleAssignment {
  return {
    userId: FIXTURE_IDS.adminUserId,
    roleId: FIXTURE_IDS.adminRoleId,
    assignedAt: new Date('2024-01-01T00:00:00.000Z'),
  };
}
