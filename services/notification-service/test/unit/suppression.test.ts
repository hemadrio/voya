/**
 * Unit tests for SuppressionRepository and hashEmail.
 *
 * Database is faked — no real Postgres.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SuppressionRepository,
  hashEmail,
} from '../../src/repositories/SuppressionRepository.js';
import type { SuppressionPrismaClient } from '../../src/repositories/SuppressionRepository.js';

function makeDb(findResult: { emailHash: string; reason: string } | null = null) {
  return {
    emailSuppression: {
      findUnique: vi.fn().mockResolvedValue(findResult),
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SuppressionPrismaClient;
}

describe('hashEmail', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashEmail('test@example.com');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is case-insensitive — uppercase and lowercase produce identical hashes', () => {
    expect(hashEmail('Test@Example.COM')).toBe(hashEmail('test@example.com'));
  });

  it('strips whitespace before hashing', () => {
    expect(hashEmail('  test@example.com  ')).toBe(hashEmail('test@example.com'));
  });

  it('different emails produce different hashes', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'));
  });

  it('raw email address is not visible in the hash output', () => {
    const email = 'sensitive@example.com';
    const hash = hashEmail(email);
    expect(hash).not.toContain('sensitive');
    expect(hash).not.toContain('example');
  });
});

describe('SuppressionRepository.isSuppressed', () => {
  it('returns false when no suppression row exists', async () => {
    const db = makeDb(null);
    const repo = new SuppressionRepository(db);

    const result = await repo.isSuppressed('clean@example.com');

    expect(result).toBe(false);
    expect(db.emailSuppression.findUnique).toHaveBeenCalledOnce();
  });

  it('returns true when a suppression row exists', async () => {
    const db = makeDb({
      emailHash: hashEmail('bounce@example.com'),
      reason: 'BOUNCE',
    });
    const repo = new SuppressionRepository(db);

    const result = await repo.isSuppressed('bounce@example.com');

    expect(result).toBe(true);
  });

  it('queries by hash, not by raw email', async () => {
    const db = makeDb(null);
    const repo = new SuppressionRepository(db);

    await repo.isSuppressed('user@example.com');

    const call = (db.emailSuppression.findUnique as ReturnType<typeof vi.fn>).mock.calls[0] as [{ where: { emailHash: string } }];
    const arg = call[0];
    expect(arg.where.emailHash).toBe(hashEmail('user@example.com'));
    expect(arg.where.emailHash).not.toContain('user');
  });
});

describe('SuppressionRepository.suppress', () => {
  it('calls upsert with hashed email and reason', async () => {
    const db = makeDb();
    const repo = new SuppressionRepository(db);

    await repo.suppress('bounce@example.com', 'BOUNCE', 'evt-001');

    expect(db.emailSuppression.upsert).toHaveBeenCalledOnce();
    const call = (db.emailSuppression.upsert as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      where: { emailHash: string };
      create: { reason: string; sourceEventId: string | null };
      update: { reason: string };
    }];
    const arg = call[0];
    expect(arg.where.emailHash).toBe(hashEmail('bounce@example.com'));
    expect(arg.create.reason).toBe('BOUNCE');
    expect(arg.create.sourceEventId).toBe('evt-001');
  });

  it('sets sourceEventId to null when not provided', async () => {
    const db = makeDb();
    const repo = new SuppressionRepository(db);

    await repo.suppress('user@example.com', 'MANUAL');

    const call = (db.emailSuppression.upsert as ReturnType<typeof vi.fn>).mock.calls[0] as [{
      create: { sourceEventId: string | null };
    }];
    expect(call[0].create.sourceEventId).toBeNull();
  });

  it('upserts on conflict — does not throw on duplicate suppress call', async () => {
    const db = makeDb();
    const repo = new SuppressionRepository(db);

    // Two calls for same email should both succeed (upsert semantics)
    await expect(repo.suppress('user@example.com', 'BOUNCE')).resolves.toBeUndefined();
    await expect(repo.suppress('user@example.com', 'COMPLAINT')).resolves.toBeUndefined();
  });
});

describe('SuppressionRepository — transient DB error propagation', () => {
  it('throws TransientDbError when DB connection fails on isSuppressed', async () => {
    const { TransientDbError } = await import('../../src/domain/backoff.js');
    const connErr = new Error('P1001 connection failed');
    (connErr as unknown as Record<string, unknown>)['code'] = 'P1001';
    const db = {
      emailSuppression: {
        findUnique: vi.fn().mockRejectedValue(connErr),
        upsert: vi.fn(),
      },
    } as unknown as SuppressionPrismaClient;
    const repo = new SuppressionRepository(db);

    await expect(repo.isSuppressed('test@example.com')).rejects.toBeInstanceOf(
      TransientDbError,
    );
  });
});
