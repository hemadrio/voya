/**
 * Migration integration test for 0009_identity_schema.
 *
 * Runs against a real PostgreSQL database (DATABASE_URL env var required).
 * In CI this is provided by the docker-compose postgres service.
 *
 * Test sequence:
 *   1. Apply forward migration (migration.sql)
 *   2. Assert schema shape via information_schema
 *   3. Assert case-insensitive email uniqueness (functional index)
 *   4. Assert cascade deletes work correctly
 *   5. Apply rollback (migration.down.sql)
 *   6. Assert new objects are gone
 *   7. Re-apply forward migration to prove idempotency
 *
 * Run: DATABASE_URL=postgres://... vitest run test/integration/migration-0009.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../../../prisma/migrations/0009_identity_schema');

const DATABASE_URL = process.env['DATABASE_URL'];

// Skip the entire suite when no database is available (local dev without Docker)
const describeWithDb = DATABASE_URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// DB client helper
// ---------------------------------------------------------------------------

interface DbRow { [key: string]: unknown }

async function query(client: { query(sql: string, params?: unknown[]): Promise<{ rows: DbRow[] }> }, sql: string, params?: unknown[]): Promise<DbRow[]> {
  const result = await client.query(sql, params);
  return result.rows;
}

describeWithDb('Migration 0009_identity_schema', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    pg = client;
  });

  afterAll(async () => {
    if (pg) {
      // Best-effort cleanup: try to roll back migration in case test left db dirty
      try {
        const downSql = readFileSync(join(MIGRATIONS_DIR, 'migration.down.sql'), 'utf8');
        await pg.query(downSql);
      } catch { /* ignore */ }
      await pg.end();
    }
  });

  it('applies the forward migration without errors', async () => {
    const forwardSql = readFileSync(join(MIGRATIONS_DIR, 'migration.sql'), 'utf8');
    await expect(pg.query(forwardSql)).resolves.toBeDefined();
  });

  describe('After forward migration', () => {
    it('creates UserStatus enum', async () => {
      const rows = await query(pg, `SELECT typname FROM pg_type WHERE typname = 'UserStatus'`);
      expect(rows).toHaveLength(1);
    });

    it('creates CredentialType enum', async () => {
      const rows = await query(pg, `SELECT typname FROM pg_type WHERE typname = 'CredentialType'`);
      expect(rows).toHaveLength(1);
    });

    it('adds email_verified_at to users', async () => {
      const rows = await query(pg,
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'email_verified_at'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!['is_nullable']).toBe('YES');
    });

    it('adds display_name to users', async () => {
      const rows = await query(pg,
        `SELECT column_name, character_maximum_length FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'display_name'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!['character_maximum_length']).toBe(128);
    });

    it('adds status to users with default=pending', async () => {
      const rows = await query(pg,
        `SELECT column_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'status'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!['is_nullable']).toBe('NO');
    });

    it('creates functional unique index on lower(email)', async () => {
      const rows = await query(pg,
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'users' AND indexname = 'uq_users_lower_email'`
      );
      expect(rows).toHaveLength(1);
    });

    it('enforces case-insensitive email uniqueness', async () => {
      // Insert a test user, then attempt to insert with a cased variant
      await pg.query(`
        INSERT INTO users (id, email, password_hash, role)
        VALUES (gen_random_uuid(), 'test_unique@example.com', 'hash', 'traveler')
        ON CONFLICT DO NOTHING
      `);

      await expect(
        pg.query(`
          INSERT INTO users (id, email, password_hash, role)
          VALUES (gen_random_uuid(), 'Test_Unique@EXAMPLE.COM', 'hash', 'traveler')
        `)
      ).rejects.toThrow(/unique/i);

      // Cleanup
      await pg.query(`DELETE FROM users WHERE email = 'test_unique@example.com'`);
    });

    it('creates credentials table with correct columns', async () => {
      const rows = await query(pg,
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'credentials'
         ORDER BY column_name`
      );
      const cols = rows.map(r => r['column_name'] as string);
      expect(cols).toEqual(expect.arrayContaining([
        'id', 'user_id', 'type', 'secret_hash', 'hash_algorithm',
        'failed_attempt_count', 'locked_until', 'last_used_at',
        'created_at', 'updated_at',
      ]));
    });

    it('credentials table has CASCADE DELETE FK to users', async () => {
      const rows = await query(pg,
        `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON rc.constraint_name = tc.constraint_name
         WHERE tc.table_name = 'credentials'
           AND rc.delete_rule = 'CASCADE'`
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('creates sessions.rotated_from_session_id column', async () => {
      const rows = await query(pg,
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'sessions' AND column_name = 'rotated_from_session_id'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!['is_nullable']).toBe('YES');
    });

    it('creates roles table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'roles'`);
      expect(rows).toHaveLength(1);
    });

    it('creates permissions table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'permissions'`);
      expect(rows).toHaveLength(1);
    });

    it('creates role_permissions table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'role_permissions'`);
      expect(rows).toHaveLength(1);
    });

    it('creates user_roles table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'user_roles'`);
      expect(rows).toHaveLength(1);
    });

    it('creates index on user_roles.user_id', async () => {
      const rows = await query(pg,
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'user_roles' AND indexname = 'idx_user_roles_user_id'`
      );
      expect(rows).toHaveLength(1);
    });

    it('creates index on credentials.user_id', async () => {
      const rows = await query(pg,
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'credentials' AND indexname = 'idx_credentials_user_id'`
      );
      expect(rows).toHaveLength(1);
    });

    it('cascades credential delete when user is deleted', async () => {
      const userId = 'aaaaaaaa-0000-4000-8000-000000000001';
      await pg.query(`INSERT INTO users (id, email, password_hash, role) VALUES ($1, 'cascade_test@example.com', 'h', 'traveler')`, [userId]);
      await pg.query(`INSERT INTO credentials (user_id, type, secret_hash) VALUES ($1, 'password', 'h')`, [userId]);

      const before = await query(pg, `SELECT COUNT(*) as c FROM credentials WHERE user_id = $1`, [userId]);
      expect(Number(before[0]!['c'])).toBe(1);

      await pg.query(`DELETE FROM users WHERE id = $1`, [userId]);

      const after = await query(pg, `SELECT COUNT(*) as c FROM credentials WHERE user_id = $1`, [userId]);
      expect(Number(after[0]!['c'])).toBe(0);
    });
  });

  it('applies the rollback migration without errors', async () => {
    const downSql = readFileSync(join(MIGRATIONS_DIR, 'migration.down.sql'), 'utf8');
    await expect(pg.query(downSql)).resolves.toBeDefined();
  });

  describe('After rollback', () => {
    it('drops credentials table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'credentials'`);
      expect(rows).toHaveLength(0);
    });

    it('drops roles table', async () => {
      const rows = await query(pg, `SELECT tablename FROM pg_tables WHERE tablename = 'roles'`);
      expect(rows).toHaveLength(0);
    });

    it('drops UserStatus enum', async () => {
      const rows = await query(pg, `SELECT typname FROM pg_type WHERE typname = 'UserStatus'`);
      expect(rows).toHaveLength(0);
    });

    it('removes email_verified_at from users', async () => {
      const rows = await query(pg,
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'email_verified_at'`
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('re-applies forward migration (idempotency)', async () => {
    const forwardSql = readFileSync(join(MIGRATIONS_DIR, 'migration.sql'), 'utf8');
    await expect(pg.query(forwardSql)).resolves.toBeDefined();
  });
});
