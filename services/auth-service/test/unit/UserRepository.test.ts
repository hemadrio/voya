/**
 * Unit tests for UserRepository.
 *
 * All tests use in-memory mock DB clients — no real database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createUserRepository,
  type UserDbClient,
  type UserEntity,
  type UserStatus,
} from '../../src/domain/UserRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'user-1',
    email: 'alice@example.com',
    emailVerifiedAt: null,
    displayName: null,
    status: 'pending',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeDb(userOverrides: Partial<UserDbClient['user']> = {}): UserDbClient {
  const defaultUser = makeUser();
  return {
    user: {
      create: vi.fn(async () => defaultUser),
      findUnique: vi.fn(async () => defaultUser),
      update: vi.fn(async () => ({ ...defaultUser, status: 'active' as UserStatus })),
      ...userOverrides,
    },
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('UserRepository.create', () => {
  it('normalizes email to lowercase + trim before insert', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.create({ email: '  Alice@EXAMPLE.COM  ' });

    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'alice@example.com' }),
      }),
    );
  });

  it('sets status=pending on new users', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.create({ email: 'alice@example.com' });

    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending' }),
      }),
    );
  });

  it('passes displayName through', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.create({ email: 'alice@example.com', displayName: 'Alice' });

    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ displayName: 'Alice' }),
      }),
    );
  });

  it('returns the created user entity', async () => {
    const created = makeUser({ id: 'new-user-id' });
    const db = makeDb({ create: vi.fn(async () => created) });
    const repo = createUserRepository(db);

    const result = await repo.create({ email: 'alice@example.com' });

    expect(result.id).toBe('new-user-id');
  });

  it('does not include secret_hash in the select list', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.create({ email: 'alice@example.com' });

    const call = (db.user.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).not.toHaveProperty('passwordHash');
    expect(call.select).not.toHaveProperty('secretHash');
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe('UserRepository.findById', () => {
  it('returns the user when found', async () => {
    const user = makeUser({ id: 'user-abc' });
    const db = makeDb({ findUnique: vi.fn(async () => user) });
    const repo = createUserRepository(db);

    const result = await repo.findById('user-abc');

    expect(result?.id).toBe('user-abc');
  });

  it('returns null when not found', async () => {
    const db = makeDb({ findUnique: vi.fn(async () => null) });
    const repo = createUserRepository(db);

    const result = await repo.findById('no-such-id');

    expect(result).toBeNull();
  });

  it('does not include secret_hash in the select list', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.findById('user-1');

    const call = (db.user.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).not.toHaveProperty('passwordHash');
    expect(call.select).not.toHaveProperty('secretHash');
  });
});

// ---------------------------------------------------------------------------
// findByEmail
// ---------------------------------------------------------------------------

describe('UserRepository.findByEmail', () => {
  it('normalizes email before lookup', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.findByEmail('  Alice@EXAMPLE.COM  ');

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'alice@example.com' },
      }),
    );
  });

  it('returns the user when found', async () => {
    const user = makeUser({ email: 'alice@example.com' });
    const db = makeDb({ findUnique: vi.fn(async () => user) });
    const repo = createUserRepository(db);

    const result = await repo.findByEmail('alice@example.com');

    expect(result?.email).toBe('alice@example.com');
  });

  it('returns null for unknown email', async () => {
    const db = makeDb({ findUnique: vi.fn(async () => null) });
    const repo = createUserRepository(db);

    const result = await repo.findByEmail('nobody@example.com');

    expect(result).toBeNull();
  });

  it('does not include secret_hash in the select list', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.findByEmail('alice@example.com');

    const call = (db.user.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.select).not.toHaveProperty('passwordHash');
    expect(call.select).not.toHaveProperty('secretHash');
  });
});

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

describe('UserRepository.updateStatus', () => {
  it('calls db.user.update with the new status', async () => {
    const db = makeDb();
    const repo = createUserRepository(db);

    await repo.updateStatus('user-1', 'active');

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({ status: 'active' }),
      }),
    );
  });

  it('returns the updated user entity', async () => {
    const updated = makeUser({ status: 'active' });
    const db = makeDb({ update: vi.fn(async () => updated) });
    const repo = createUserRepository(db);

    const result = await repo.updateStatus('user-1', 'active');

    expect(result.status).toBe('active');
  });

  it('can transition to suspended', async () => {
    const db = makeDb({ update: vi.fn(async () => makeUser({ status: 'suspended' })) });
    const repo = createUserRepository(db);

    await repo.updateStatus('user-1', 'suspended');

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'suspended' }) }),
    );
  });

  it('can transition to deleted', async () => {
    const db = makeDb({ update: vi.fn(async () => makeUser({ status: 'deleted' })) });
    const repo = createUserRepository(db);

    await repo.updateStatus('user-1', 'deleted');

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'deleted' }) }),
    );
  });
});
