/**
 * CredentialRepository — typed data-access for the credentials table.
 *
 * SECURITY INVARIANT:
 *   secret_hash must never be returned by the default select.
 *   Callers that need to verify a password must use findWithSecretByUserId
 *   which explicitly opts in to loading the hash.
 *
 * Hexagonal architecture: depends only on injected interfaces.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialType = 'password' | 'oauth' | 'totp';

/** Safe credential view — no secret_hash. */
export interface CredentialEntity {
  id: string;
  userId: string;
  type: CredentialType;
  hashAlgorithm: string;
  failedAttemptCount: number;
  lockedUntil: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Full credential including secret_hash — only for password verification. */
export interface CredentialWithSecret extends CredentialEntity {
  secretHash: string;
}

export interface CreateCredentialInput {
  userId: string;
  type?: CredentialType;
  secretHash: string;
  hashAlgorithm?: string;
}

// ---------------------------------------------------------------------------
// DB client interface (duck-typed against Prisma)
// ---------------------------------------------------------------------------

type SafeSelect = {
  id: true;
  userId: true;
  type: true;
  hashAlgorithm: true;
  failedAttemptCount: true;
  lockedUntil: true;
  lastUsedAt: true;
  createdAt: true;
  updatedAt: true;
};

type FullSelect = SafeSelect & { secretHash: true };

interface CredentialCreateArgs {
  data: {
    userId: string;
    type: CredentialType;
    secretHash: string;
    hashAlgorithm: string;
  };
  select: SafeSelect;
}

interface CredentialFindArgs<S> {
  where: { userId: string; type?: CredentialType };
  select: S;
  orderBy?: { createdAt: 'desc' | 'asc' };
}

export interface CredentialDbClient {
  credential: {
    create(args: CredentialCreateArgs): Promise<CredentialEntity>;
    findFirst(args: CredentialFindArgs<SafeSelect>): Promise<CredentialEntity | null>;
    findFirst(args: CredentialFindArgs<FullSelect>): Promise<CredentialWithSecret | null>;
  };
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface CredentialRepository {
  /** Create a new credential row. secretHash must already be hashed. */
  create(input: CreateCredentialInput): Promise<CredentialEntity>;

  /** Find the most-recently-created credential for a user (safe — no hash). */
  findByUserId(userId: string, type?: CredentialType): Promise<CredentialEntity | null>;

  /**
   * Find a credential including the secret_hash for password verification.
   * This is the ONLY function that returns the hash — call sites must be
   * audited and reviewed for correctness.
   */
  findWithSecretByUserId(userId: string, type?: CredentialType): Promise<CredentialWithSecret | null>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SAFE_SELECT: SafeSelect = {
  id: true,
  userId: true,
  type: true,
  hashAlgorithm: true,
  failedAttemptCount: true,
  lockedUntil: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
};

const FULL_SELECT: FullSelect = {
  ...SAFE_SELECT,
  secretHash: true,
};

export function createCredentialRepository(db: CredentialDbClient): CredentialRepository {
  return {
    async create({ userId, type = 'password', secretHash, hashAlgorithm = 'argon2id' }: CreateCredentialInput): Promise<CredentialEntity> {
      return db.credential.create({
        data: { userId, type, secretHash, hashAlgorithm },
        select: SAFE_SELECT,
      });
    },

    async findByUserId(userId: string, type?: CredentialType): Promise<CredentialEntity | null> {
      return db.credential.findFirst({
        where: type ? { userId, type } : { userId },
        select: SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
      });
    },

    async findWithSecretByUserId(userId: string, type?: CredentialType): Promise<CredentialWithSecret | null> {
      return db.credential.findFirst({
        where: type ? { userId, type } : { userId },
        select: FULL_SELECT,
        orderBy: { createdAt: 'desc' },
      }) as Promise<CredentialWithSecret | null>;
    },
  };
}
