/**
 * RoleRepository — typed data-access for roles, permissions and user-role assignments.
 *
 * Exposes narrow intent-revealing functions rather than a generic query builder.
 * Hexagonal architecture: depends only on injected interfaces.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleEntity {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface UserRoleAssignment {
  userId: string;
  roleId: string;
  assignedAt: Date;
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

type RoleSelect = { id: true; name: true; description: true; createdAt: true };
type AssignmentSelect = { userId: true; roleId: true; assignedAt: true };

interface RoleCreateArgs {
  data: { name: string; description?: string | null };
  select: RoleSelect;
}

interface RoleFindArgs {
  where: { name: string } | { id: string };
  select: RoleSelect;
}

interface RolesFindArgs {
  where: { userRoles: { some: { userId: string } } };
  select: RoleSelect;
}

interface AssignmentCreateArgs {
  data: { userId: string; roleId: string };
  select: AssignmentSelect;
}

interface AssignmentFindArgs {
  where: { userId: string; roleId: string };
  select: AssignmentSelect;
}

export interface RoleDbClient {
  role: {
    create(args: RoleCreateArgs): Promise<RoleEntity>;
    findUnique(args: RoleFindArgs): Promise<RoleEntity | null>;
    findMany(args: RolesFindArgs): Promise<RoleEntity[]>;
  };
  userRoleEntry: {
    create(args: AssignmentCreateArgs): Promise<UserRoleAssignment>;
    findUnique(args: AssignmentFindArgs): Promise<UserRoleAssignment | null>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface RoleRepository {
  /** Create a named role. Throws on duplicate name (unique constraint). */
  create(input: CreateRoleInput): Promise<RoleEntity>;

  /** Find a role by name. Returns null if not found. */
  findByName(name: string): Promise<RoleEntity | null>;

  /**
   * Assign a role to a user.
   * Returns the assignment; throws a unique-constraint error if already assigned.
   */
  assignToUser(userId: string, roleId: string): Promise<UserRoleAssignment>;

  /**
   * Return all roles currently assigned to a user.
   * Returns an empty array if the user has no roles.
   */
  findRolesForUser(userId: string): Promise<RoleEntity[]>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ROLE_SELECT: RoleSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
};

const ASSIGNMENT_SELECT: AssignmentSelect = {
  userId: true,
  roleId: true,
  assignedAt: true,
};

export function createRoleRepository(db: RoleDbClient): RoleRepository {
  return {
    async create({ name, description }: CreateRoleInput): Promise<RoleEntity> {
      return db.role.create({
        data: { name, description: description ?? null },
        select: ROLE_SELECT,
      });
    },

    async findByName(name: string): Promise<RoleEntity | null> {
      return db.role.findUnique({
        where: { name },
        select: ROLE_SELECT,
      });
    },

    async assignToUser(userId: string, roleId: string): Promise<UserRoleAssignment> {
      return db.userRoleEntry.create({
        data: { userId, roleId },
        select: ASSIGNMENT_SELECT,
      });
    },

    async findRolesForUser(userId: string): Promise<RoleEntity[]> {
      return db.role.findMany({
        where: { userRoles: { some: { userId } } },
        select: ROLE_SELECT,
      });
    },
  };
}
