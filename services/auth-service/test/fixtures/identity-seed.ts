/**
 * Identity seed script — loads deterministic fixtures into a real database.
 *
 * Creates:
 *   - admin user (active, email verified) + admin role
 *   - verified standard user (active, email verified) + traveler role
 *   - unverified user (pending, no email_verified_at)
 *   - locked user (active, credential locked until 2099)
 *   - one active session for the verified user
 *
 * The script is idempotent: it uses upsert patterns so re-running against a
 * database that already has these rows is safe.
 *
 * Usage (requires DATABASE_URL in environment):
 *   tsx services/auth-service/test/fixtures/identity-seed.ts
 *
 * Note: secretHash values use a placeholder Argon2id-shaped string.
 * Real deployments must generate proper hashes before inserting.
 */

import { FIXTURE_IDS } from './identity-factories.js';

// Duck-typed DB client interface — matches the Prisma client's shape.
interface SeedDbClient {
  user: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  credential: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  role: {
    upsert(args: {
      where: { name: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  userRoleEntry: {
    upsert(args: {
      where: { userId_roleId: { userId: string; roleId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ userId: string }>;
  };
  session: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
}

const PLACEHOLDER_HASH = '$argon2id$v=19$m=65536,t=3,p=4$cGxhY2Vob2xkZXI$cGxhY2Vob2xkZXJoYXNo';
const SEED_DATE = new Date('2024-01-01T00:00:00.000Z');
const SESSION_EXPIRES = new Date('2099-12-31T23:59:59.000Z');

export async function seedIdentityFixtures(db: SeedDbClient): Promise<void> {
  // Roles
  await db.role.upsert({
    where: { name: 'admin' },
    create: { id: FIXTURE_IDS.adminRoleId, name: 'admin', description: 'Platform administrator' },
    update: { description: 'Platform administrator' },
  });
  await db.role.upsert({
    where: { name: 'traveler' },
    create: { id: FIXTURE_IDS.travelerRoleId, name: 'traveler', description: 'Standard traveler' },
    update: { description: 'Standard traveler' },
  });

  // Admin user
  await db.user.upsert({
    where: { id: FIXTURE_IDS.adminUserId },
    create: {
      id: FIXTURE_IDS.adminUserId,
      email: 'admin@example.com',
      passwordHash: PLACEHOLDER_HASH,
      status: 'active',
      emailVerifiedAt: SEED_DATE,
      displayName: 'Platform Admin',
      role: 'traveler',
    },
    update: { status: 'active', emailVerifiedAt: SEED_DATE },
  });
  await db.credential.upsert({
    where: { id: FIXTURE_IDS.adminCredId },
    create: {
      id: FIXTURE_IDS.adminCredId,
      userId: FIXTURE_IDS.adminUserId,
      type: 'password',
      secretHash: PLACEHOLDER_HASH,
      hashAlgorithm: 'argon2id',
    },
    update: {},
  });
  await db.userRoleEntry.upsert({
    where: { userId_roleId: { userId: FIXTURE_IDS.adminUserId, roleId: FIXTURE_IDS.adminRoleId } },
    create: { userId: FIXTURE_IDS.adminUserId, roleId: FIXTURE_IDS.adminRoleId },
    update: {},
  });

  // Verified standard user
  await db.user.upsert({
    where: { id: FIXTURE_IDS.verifiedUserId },
    create: {
      id: FIXTURE_IDS.verifiedUserId,
      email: 'alice@example.com',
      passwordHash: PLACEHOLDER_HASH,
      status: 'active',
      emailVerifiedAt: SEED_DATE,
      displayName: 'Alice',
      role: 'traveler',
    },
    update: { status: 'active', emailVerifiedAt: SEED_DATE },
  });
  await db.credential.upsert({
    where: { id: FIXTURE_IDS.verifiedCredId },
    create: {
      id: FIXTURE_IDS.verifiedCredId,
      userId: FIXTURE_IDS.verifiedUserId,
      type: 'password',
      secretHash: PLACEHOLDER_HASH,
      hashAlgorithm: 'argon2id',
    },
    update: {},
  });
  await db.userRoleEntry.upsert({
    where: { userId_roleId: { userId: FIXTURE_IDS.verifiedUserId, roleId: FIXTURE_IDS.travelerRoleId } },
    create: { userId: FIXTURE_IDS.verifiedUserId, roleId: FIXTURE_IDS.travelerRoleId },
    update: {},
  });

  // Unverified user (status = pending)
  await db.user.upsert({
    where: { id: FIXTURE_IDS.unverifiedUserId },
    create: {
      id: FIXTURE_IDS.unverifiedUserId,
      email: 'bob@example.com',
      passwordHash: PLACEHOLDER_HASH,
      status: 'pending',
      displayName: 'Bob',
      role: 'traveler',
    },
    update: { status: 'pending' },
  });

  // Locked user (credential locked until far future)
  await db.user.upsert({
    where: { id: FIXTURE_IDS.lockedUserId },
    create: {
      id: FIXTURE_IDS.lockedUserId,
      email: 'charlie@example.com',
      passwordHash: PLACEHOLDER_HASH,
      status: 'active',
      emailVerifiedAt: SEED_DATE,
      displayName: 'Charlie',
      role: 'traveler',
    },
    update: { status: 'active' },
  });
  await db.credential.upsert({
    where: { id: FIXTURE_IDS.lockedCredId },
    create: {
      id: FIXTURE_IDS.lockedCredId,
      userId: FIXTURE_IDS.lockedUserId,
      type: 'password',
      secretHash: PLACEHOLDER_HASH,
      hashAlgorithm: 'argon2id',
      failedAttemptCount: 5,
      lockedUntil: new Date('2099-12-31T23:59:59.000Z'),
    },
    update: {},
  });

  // Active session for verified user
  await db.session.upsert({
    where: { id: FIXTURE_IDS.activeSessionId },
    create: {
      id: FIXTURE_IDS.activeSessionId,
      userId: FIXTURE_IDS.verifiedUserId,
      token: `__seed_token_${FIXTURE_IDS.activeSessionId}`,
      refreshTokenHash: 'sha256-seed-refresh-token-hash',
      userAgent: 'SeedScript/1.0',
      ipAddress: '127.0.0.1',
      expiresAt: SESSION_EXPIRES,
    },
    update: {},
  });
}
