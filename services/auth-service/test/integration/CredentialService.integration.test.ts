/**
 * Integration tests for CredentialService against a real database.
 *
 * Requires DATABASE_URL in the environment (provided by docker-compose postgres).
 * Skipped automatically when DATABASE_URL is unset.
 *
 * Run: DATABASE_URL=postgres://... vitest run test/integration/CredentialService.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCredentialService,
  type ICredentialService,
} from '../../src/domain/CredentialService.js';
import type { CredentialServiceConfig } from '../../src/domain/credentialServiceConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env['DATABASE_URL'];
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// Fast config for integration tests (avoids real argon2 cost in CI)
const TEST_CONFIG: CredentialServiceConfig = {
  scrypt: { N: 1024, r: 8, p: 1, keyLen: 64 },
  lockout: { threshold: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  policy: { minLength: 12, maxLength: 128 },
  commonPasswordsPath: join(__dirname, '../fixtures/common-passwords.txt'),
};

// ---------------------------------------------------------------------------
// Prisma-shaped DB client factory
// ---------------------------------------------------------------------------

async function buildDbClient() {
  // Dynamically import pg to avoid loading it in non-DB test runs
  const { Client } = await import('pg');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Minimal adapter that translates our duck-typed interface to raw SQL
  return {
    client,
    credential: {
      findFirst: async (args: { where: { id: string }; select: Record<string, true> }) => {
        const result = await client.query(
          'SELECT id, failed_attempt_count, locked_until FROM credentials WHERE id = $1',
          [args.where.id],
        );
        if (!result.rows[0]) return null;
        const row = result.rows[0];
        return {
          id: row.id as string,
          failedAttemptCount: Number(row.failed_attempt_count),
          lockedUntil: row.locked_until ? new Date(row.locked_until as string) : null,
        };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const data = args.data;
        // Handle increment
        let countExpr = 'failed_attempt_count';
        const params: unknown[] = [args.where.id];
        let idx = 2;

        if (typeof data['failedAttemptCount'] === 'object' && data['failedAttemptCount'] !== null) {
          const inc = (data['failedAttemptCount'] as { increment: number }).increment;
          countExpr = `failed_attempt_count + ${inc}`;
        } else if (typeof data['failedAttemptCount'] === 'number') {
          countExpr = `$${idx}`;
          params.push(data['failedAttemptCount']);
          idx++;
        }

        let lockedUntilExpr = 'locked_until';
        if ('lockedUntil' in data) {
          lockedUntilExpr = `$${idx}`;
          params.push(data['lockedUntil'] ?? null);
          idx++;
        }

        const result = await client.query(
          `UPDATE credentials SET failed_attempt_count = ${countExpr}, locked_until = ${lockedUntilExpr}, updated_at = NOW() WHERE id = $1 RETURNING id, failed_attempt_count, locked_until`,
          params,
        );
        const row = result.rows[0];
        return {
          id: row.id as string,
          failedAttemptCount: Number(row.failed_attempt_count),
          lockedUntil: row.locked_until ? new Date(row.locked_until as string) : null,
        };
      },
    },
  };
}

describeWithDb('CredentialService integration tests', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let svc: ICredentialService;
  let testUserId: string;
  let testCredId: string;

  beforeAll(async () => {
    db = await buildDbClient();
    svc = createCredentialService(TEST_CONFIG, db);

    // Create a fresh test user + credential row
    const userResult = await db.client.query(
      `INSERT INTO users (id, email, password_hash, role, status)
       VALUES (gen_random_uuid(), 'credtest_' || gen_random_uuid() || '@example.com', 'placeholder', 'traveler', 'pending')
       RETURNING id`,
    );
    testUserId = userResult.rows[0].id as string;

    const { hash, algorithm } = await svc.hashPassword('IntegrationPass!99');
    const credResult = await db.client.query(
      `INSERT INTO credentials (user_id, type, secret_hash, hash_algorithm)
       VALUES ($1, 'password', $2, $3)
       RETURNING id`,
      [testUserId, hash, algorithm],
    );
    testCredId = credResult.rows[0].id as string;
  });

  afterAll(async () => {
    // Cleanup: delete user (credentials cascade)
    if (testUserId && db?.client) {
      await db.client.query('DELETE FROM users WHERE id = $1', [testUserId]);
      await db.client.end();
    }
  });

  it('persists hash in PHC format ($scrypt$...)', async () => {
    const result = await db.client.query(
      'SELECT secret_hash, hash_algorithm FROM credentials WHERE id = $1',
      [testCredId],
    );
    const row = result.rows[0];
    expect(row.secret_hash as string).toMatch(/^\$scrypt\$/);
    expect(row.hash_algorithm as string).toBe('scrypt');
  });

  it('verifies the stored hash against the original password', async () => {
    const result = await db.client.query(
      'SELECT secret_hash FROM credentials WHERE id = $1',
      [testCredId],
    );
    const { secret_hash } = result.rows[0] as { secret_hash: string };

    const verify = await svc.verifyPassword('IntegrationPass!99', secret_hash);
    expect(verify.valid).toBe(true);
  });

  it('recordFailedAttempt increments failed_attempt_count in the database', async () => {
    // Reset first
    await db.client.query(
      'UPDATE credentials SET failed_attempt_count = 0, locked_until = NULL WHERE id = $1',
      [testCredId],
    );

    await svc.recordFailedAttempt(testCredId);
    await svc.recordFailedAttempt(testCredId);

    const result = await db.client.query(
      'SELECT failed_attempt_count FROM credentials WHERE id = $1',
      [testCredId],
    );
    expect(Number(result.rows[0].failed_attempt_count)).toBe(2);
  });

  it('sets locked_until after reaching the lockout threshold', async () => {
    // Reset counter to threshold-1
    await db.client.query(
      'UPDATE credentials SET failed_attempt_count = $1, locked_until = NULL WHERE id = $2',
      [TEST_CONFIG.lockout.threshold - 1, testCredId],
    );

    await svc.recordFailedAttempt(testCredId);

    const result = await db.client.query(
      'SELECT locked_until FROM credentials WHERE id = $1',
      [testCredId],
    );
    expect(result.rows[0].locked_until).not.toBeNull();
  });

  it('resetFailedAttempts clears failed_attempt_count and locked_until', async () => {
    await svc.resetFailedAttempts(testCredId);

    const result = await db.client.query(
      'SELECT failed_attempt_count, locked_until FROM credentials WHERE id = $1',
      [testCredId],
    );
    const row = result.rows[0];
    expect(Number(row.failed_attempt_count)).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it('isLocked returns false after reset', async () => {
    await svc.resetFailedAttempts(testCredId);
    const status = await svc.isLocked(testCredId);
    expect(status.locked).toBe(false);
  });

  it('needsRehash triggers on outdated hash', async () => {
    // Hash with different params than current config
    const lowCostConfig: CredentialServiceConfig = {
      ...TEST_CONFIG,
      scrypt: { N: 512, r: 8, p: 1, keyLen: 64 },
    };
    const lowCostSvc = createCredentialService(lowCostConfig, db);
    const { hash: oldHash } = await lowCostSvc.hashPassword('IntegrationPass!99');

    const result = await svc.verifyPassword('IntegrationPass!99', oldHash);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });
});
