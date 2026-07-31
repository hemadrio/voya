/**
 * Unit tests for IdentitySessionRepository.
 *
 * Covers: create, findActiveByRefreshHash (including expired/revoked paths), revoke.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createIdentitySessionRepository,
  type IdentitySessionDbClient,
  type SessionEntity,
} from '../../src/domain/IdentitySessionRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<{
  id: string;
  userId: string;
  refreshTokenHash: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedFromSessionId: string | null;
}> = {}) {
  return {
    id: 'session-1',
    userId: 'user-1',
    refreshTokenHash: 'hash-abc',
    userAgent: 'TestBrowser/1.0',
    ipAddress: '127.0.0.1',
    createdAt: new Date('2024-01-01'),
    expiresAt: new Date('2099-01-01'),
    revokedAt: null,
    rotatedFromSessionId: null,
    ...overrides,
  };
}

function makeDb(overrides: Partial<IdentitySessionDbClient['session']> = {}): IdentitySessionDbClient {
  const defaultRow = makeRow();
  return {
    session: {
      create: vi.fn(async () => defaultRow),
      findFirst: vi.fn(async () => defaultRow),
      update: vi.fn(async () => ({ ...defaultRow, revokedAt: new Date() })),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('IdentitySessionRepository.create', () => {
  it('stores refreshTokenHash (not the raw token)', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    await repo.create({
      userId: 'user-1',
      refreshTokenHash: 'sha256-hashed-token',
      expiresAt: new Date('2099-01-01'),
    });

    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refreshTokenHash: 'sha256-hashed-token' }),
      }),
    );
  });

  it('maps createdAt to issuedAt in the returned entity', async () => {
    const issued = new Date('2024-06-15');
    const db = makeDb({ create: vi.fn(async () => makeRow({ createdAt: issued })) });
    const repo = createIdentitySessionRepository(db);

    const result = await repo.create({
      userId: 'user-1',
      refreshTokenHash: 'hash',
      expiresAt: new Date('2099-01-01'),
    });

    expect(result.issuedAt).toEqual(issued);
  });

  it('stores rotatedFromSessionId when provided', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    await repo.create({
      userId: 'user-1',
      refreshTokenHash: 'hash',
      expiresAt: new Date('2099-01-01'),
      rotatedFromSessionId: 'previous-session-id',
    });

    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rotatedFromSessionId: 'previous-session-id' }),
      }),
    );
  });

  it('defaults rotatedFromSessionId to null when not provided', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    await repo.create({
      userId: 'user-1',
      refreshTokenHash: 'hash',
      expiresAt: new Date('2099-01-01'),
    });

    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rotatedFromSessionId: null }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// findActiveByRefreshHash
// ---------------------------------------------------------------------------

describe('IdentitySessionRepository.findActiveByRefreshHash', () => {
  it('returns session entity when found and active', async () => {
    const row = makeRow({ id: 'session-found' });
    const db = makeDb({ findFirst: vi.fn(async () => row) });
    const repo = createIdentitySessionRepository(db);

    const result = await repo.findActiveByRefreshHash('hash-abc');

    expect(result?.id).toBe('session-found');
  });

  it('queries with revokedAt=null and expiresAt>now', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    await repo.findActiveByRefreshHash('hash-abc');

    expect(db.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          refreshTokenHash: 'hash-abc',
          revokedAt: null,
          expiresAt: expect.objectContaining({ gt: expect.any(Date) }),
        }),
      }),
    );
  });

  it('returns null when session is not found', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const repo = createIdentitySessionRepository(db);

    const result = await repo.findActiveByRefreshHash('nonexistent-hash');

    expect(result).toBeNull();
  });

  it('returns null when session is revoked', async () => {
    // Simulate DB returning null because revokedAt IS NOT NULL (filtered by query)
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const repo = createIdentitySessionRepository(db);

    const result = await repo.findActiveByRefreshHash('revoked-hash');

    expect(result).toBeNull();
  });

  it('maps issuedAt from createdAt', async () => {
    const issued = new Date('2024-03-01');
    const db = makeDb({ findFirst: vi.fn(async () => makeRow({ createdAt: issued })) });
    const repo = createIdentitySessionRepository(db);

    const result = await repo.findActiveByRefreshHash('hash');

    expect(result?.issuedAt).toEqual(issued);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe('IdentitySessionRepository.revoke', () => {
  it('calls db.session.update with revokedAt=now', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    await repo.revoke('session-1');

    expect(db.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-1' },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it('resolves without returning a value', async () => {
    const db = makeDb();
    const repo = createIdentitySessionRepository(db);

    const result = await repo.revoke('session-1');

    expect(result).toBeUndefined();
  });
});
