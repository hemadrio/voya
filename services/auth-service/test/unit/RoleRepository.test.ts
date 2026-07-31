/**
 * Unit tests for RoleRepository.
 *
 * Covers: create, findByName, assignToUser, findRolesForUser.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createRoleRepository,
  type RoleDbClient,
  type RoleEntity,
  type UserRoleAssignment,
} from '../../src/domain/RoleRepository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRole(overrides: Partial<RoleEntity> = {}): RoleEntity {
  return {
    id: 'role-1',
    name: 'traveler',
    description: 'Standard traveler',
    createdAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<UserRoleAssignment> = {}): UserRoleAssignment {
  return {
    userId: 'user-1',
    roleId: 'role-1',
    assignedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeDb(overrides: { role?: Partial<RoleDbClient['role']>; userRoleEntry?: Partial<RoleDbClient['userRoleEntry']> } = {}): RoleDbClient {
  return {
    role: {
      create: vi.fn(async () => makeRole()),
      findUnique: vi.fn(async () => makeRole()),
      findMany: vi.fn(async () => [makeRole()]),
      ...overrides.role,
    },
    userRoleEntry: {
      create: vi.fn(async () => makeAssignment()),
      findUnique: vi.fn(async () => makeAssignment()),
      ...overrides.userRoleEntry,
    },
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('RoleRepository.create', () => {
  it('creates role with name and description', async () => {
    const db = makeDb();
    const repo = createRoleRepository(db);

    await repo.create({ name: 'admin', description: 'Admin role' });

    expect(db.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: 'admin', description: 'Admin role' }),
      }),
    );
  });

  it('returns the created role', async () => {
    const role = makeRole({ name: 'admin' });
    const db = makeDb({ role: { create: vi.fn(async () => role) } });
    const repo = createRoleRepository(db);

    const result = await repo.create({ name: 'admin' });

    expect(result.name).toBe('admin');
  });

  it('uses null for missing description', async () => {
    const db = makeDb();
    const repo = createRoleRepository(db);

    await repo.create({ name: 'admin' });

    expect(db.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: null }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// findByName
// ---------------------------------------------------------------------------

describe('RoleRepository.findByName', () => {
  it('returns the role when found', async () => {
    const role = makeRole({ name: 'admin' });
    const db = makeDb({ role: { findUnique: vi.fn(async () => role) } });
    const repo = createRoleRepository(db);

    const result = await repo.findByName('admin');

    expect(result?.name).toBe('admin');
  });

  it('returns null when not found', async () => {
    const db = makeDb({ role: { findUnique: vi.fn(async () => null) } });
    const repo = createRoleRepository(db);

    const result = await repo.findByName('no-such-role');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assignToUser
// ---------------------------------------------------------------------------

describe('RoleRepository.assignToUser', () => {
  it('creates a user_roles entry', async () => {
    const db = makeDb();
    const repo = createRoleRepository(db);

    await repo.assignToUser('user-1', 'role-1');

    expect(db.userRoleEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: 'user-1', roleId: 'role-1' },
      }),
    );
  });

  it('returns the assignment', async () => {
    const assignment = makeAssignment({ userId: 'user-1', roleId: 'role-1' });
    const db = makeDb({ userRoleEntry: { create: vi.fn(async () => assignment) } });
    const repo = createRoleRepository(db);

    const result = await repo.assignToUser('user-1', 'role-1');

    expect(result.userId).toBe('user-1');
    expect(result.roleId).toBe('role-1');
  });
});

// ---------------------------------------------------------------------------
// findRolesForUser
// ---------------------------------------------------------------------------

describe('RoleRepository.findRolesForUser', () => {
  it('returns roles assigned to the user', async () => {
    const roles = [makeRole({ name: 'traveler' }), makeRole({ id: 'role-2', name: 'admin' })];
    const db = makeDb({ role: { findMany: vi.fn(async () => roles) } });
    const repo = createRoleRepository(db);

    const result = await repo.findRolesForUser('user-1');

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('traveler');
  });

  it('returns empty array when user has no roles', async () => {
    const db = makeDb({ role: { findMany: vi.fn(async () => []) } });
    const repo = createRoleRepository(db);

    const result = await repo.findRolesForUser('user-with-no-roles');

    expect(result).toEqual([]);
  });

  it('queries by userId in userRoles relationship', async () => {
    const db = makeDb();
    const repo = createRoleRepository(db);

    await repo.findRolesForUser('user-1');

    expect(db.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userRoles: { some: { userId: 'user-1' } } },
      }),
    );
  });
});
