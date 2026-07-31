/**
 * UserRepository — typed data-access for the users table.
 *
 * Hexagonal architecture: depends only on injected interfaces.
 * Never returns credential (password hash) data — use CredentialRepository for that.
 * Email normalization (trim + lowercase) is enforced here regardless of what the
 * caller supplies, keeping behavior consistent with the functional unique index.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserStatus = 'active' | 'pending' | 'suspended' | 'deleted';

/** Safe user entity — never includes secret_hash or password_hash. */
export interface UserEntity {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  displayName: string | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  /** Will be normalized to trim().toLowerCase() before insert. */
  email: string;
  displayName?: string | null;
}

// ---------------------------------------------------------------------------
// DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

type UserSafeSelect = {
  id: true;
  email: true;
  emailVerifiedAt: true;
  displayName: true;
  status: true;
  createdAt: true;
  updatedAt: true;
};

interface UserCreateArgs {
  data: {
    email: string;
    displayName?: string | null;
    status: UserStatus;
  };
  select: UserSafeSelect;
}

interface UserFindUniqueArgs {
  where: { id: string } | { email: string };
  select: UserSafeSelect;
}

interface UserUpdateArgs {
  where: { id: string };
  data: { status: UserStatus; updatedAt?: Date };
  select: UserSafeSelect;
}

export interface UserDbClient {
  user: {
    create(args: UserCreateArgs): Promise<UserEntity>;
    findUnique(args: UserFindUniqueArgs): Promise<UserEntity | null>;
    update(args: UserUpdateArgs): Promise<UserEntity>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface UserRepository {
  /** Create a new user with status=pending. Email is normalized before insert. */
  create(input: CreateUserInput): Promise<UserEntity>;

  /** Find a user by UUID. Returns null if not found. */
  findById(id: string): Promise<UserEntity | null>;

  /**
   * Find a user by email address.
   * Email is normalized (trim + lowercase) before the lookup, matching the
   * functional unique index and the case-insensitive uniqueness invariant.
   */
  findByEmail(email: string): Promise<UserEntity | null>;

  /**
   * Update the account lifecycle status.
   * Only the four enum values (active, pending, suspended, deleted) are accepted.
   */
  updateStatus(id: string, status: UserStatus): Promise<UserEntity>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const USER_SAFE_SELECT = {
  id: true as const,
  email: true as const,
  emailVerifiedAt: true as const,
  displayName: true as const,
  status: true as const,
  createdAt: true as const,
  updatedAt: true as const,
} satisfies UserSafeSelect;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUserRepository(db: UserDbClient): UserRepository {
  return {
    async create({ email, displayName }: CreateUserInput): Promise<UserEntity> {
      return db.user.create({
        data: {
          email: normalizeEmail(email),
          displayName: displayName ?? null,
          status: 'pending',
        },
        select: USER_SAFE_SELECT,
      });
    },

    async findById(id: string): Promise<UserEntity | null> {
      return db.user.findUnique({
        where: { id },
        select: USER_SAFE_SELECT,
      });
    },

    async findByEmail(email: string): Promise<UserEntity | null> {
      return db.user.findUnique({
        where: { email: normalizeEmail(email) },
        select: USER_SAFE_SELECT,
      });
    },

    async updateStatus(id: string, status: UserStatus): Promise<UserEntity> {
      return db.user.update({
        where: { id },
        data: { status, updatedAt: new Date() },
        select: USER_SAFE_SELECT,
      });
    },
  };
}
