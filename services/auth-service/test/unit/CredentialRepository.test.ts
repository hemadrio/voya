/**
 * Unit tests for CredentialRepository.
 *
 * Covers: create, findByUserId (safe — no hash), findWithSecretByUserId,
 * and the critical invariant that the default select never returns secret_hash.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createCredentialRepository,
  type CredentialDbClient,
  type CredentialEntity,
  type CredentialWithSecret,
} from '../../src/domain/CredentialRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCred(overrides: Partial<CredentialEntity> = {}): CredentialEntity {
  return {
    id: 'cred-1',
    userId: 'user-1',
    type: 'password',
    hashAlgorithm: 'argon2id',
    failedAttemptCount: 0,
    lockedUntil: null,
    lastUsedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeCredWithSecret(overrides: Partial<CredentialWithSecret> = {}): CredentialWithSecret {
  return {
    ...makeCred(),
    secretHash: '$argon2id$v=19$...',
    ...overrides,
  };
}

function makeDb(overrides: Partial<CredentialDbClient['credential']> = {}): CredentialDbClient {
  const defaultCred = makeCred();
  return {
    credential: {
      create: vi.fn(async () => defaultCred),
      findFirst: vi.fn(async () => defaultCred),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('CredentialRepository.create', () => {
  it('stores provided secretHash', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.create({ userId: 'user-1', secretHash: '$argon2id$v=19$...' });

    expect(db.credential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ secretHash: '$argon2id$v=19$...' }),
      }),
    );
  });

  it('defaults type to password', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.create({ userId: 'user-1', secretHash: 'hash' });

    expect(db.credential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'password' }),
      }),
    );
  });

  it('defaults hashAlgorithm to argon2id', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.create({ userId: 'user-1', secretHash: 'hash' });

    expect(db.credential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hashAlgorithm: 'argon2id' }),
      }),
    );
  });

  it('does NOT return secretHash in the result', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    const result = await repo.create({ userId: 'user-1', secretHash: 'hash' });

    expect(result).not.toHaveProperty('secretHash');
  });

  it('does not include secretHash in the select list', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.create({ userId: 'user-1', secretHash: 'hash' });

    const call = (db.credential.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).not.toHaveProperty('secretHash');
  });
});

// ---------------------------------------------------------------------------
// findByUserId
// ---------------------------------------------------------------------------

describe('CredentialRepository.findByUserId', () => {
  it('returns credential entity without secretHash', async () => {
    const cred = makeCred({ userId: 'user-1' });
    const db = makeDb({ findFirst: vi.fn(async () => cred) });
    const repo = createCredentialRepository(db);

    const result = await repo.findByUserId('user-1');

    expect(result?.userId).toBe('user-1');
    expect(result).not.toHaveProperty('secretHash');
  });

  it('returns null when no credential exists', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const repo = createCredentialRepository(db);

    const result = await repo.findByUserId('no-such-user');

    expect(result).toBeNull();
  });

  it('filters by type when provided', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.findByUserId('user-1', 'oauth');

    expect(db.credential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: 'oauth' }),
      }),
    );
  });

  it('does not include secretHash in the select list', async () => {
    const db = makeDb();
    const repo = createCredentialRepository(db);

    await repo.findByUserId('user-1');

    const call = (db.credential.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).not.toHaveProperty('secretHash');
  });
});

// ---------------------------------------------------------------------------
// findWithSecretByUserId — the only path that returns the hash
// ---------------------------------------------------------------------------

describe('CredentialRepository.findWithSecretByUserId', () => {
  it('includes secretHash in the result', async () => {
    const credWithSecret = makeCredWithSecret({ userId: 'user-1' });
    const db = makeDb({ findFirst: vi.fn(async () => credWithSecret) });
    const repo = createCredentialRepository(db);

    const result = await repo.findWithSecretByUserId('user-1');

    expect(result?.secretHash).toBe('$argon2id$v=19$...');
  });

  it('returns null when not found', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => null) });
    const repo = createCredentialRepository(db);

    const result = await repo.findWithSecretByUserId('no-such-user');

    expect(result).toBeNull();
  });

  it('includes secretHash in the select list', async () => {
    const db = makeDb({ findFirst: vi.fn(async () => makeCredWithSecret()) });
    const repo = createCredentialRepository(db);

    await repo.findWithSecretByUserId('user-1');

    const call = (db.credential.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).toHaveProperty('secretHash', true);
  });
});
