/**
 * SubjectDataKeyRepository — per-subject DEK registry (WO-104).
 *
 * Manages the subject_data_keys table: creation of versioned wrapped DEKs,
 * lookup for decryption, and cryptographic erasure via destroyed_at.
 *
 * Cryptographic erasure: setting destroyed_at makes the key permanently
 * unusable for decryption without destroying the KMS CMK. All ciphertext
 * encrypted under that key becomes permanently unrecoverable.
 */

import type { WrappedKey } from "@travel/crypto";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface SubjectDataKeyRow {
  id: string;
  userId: string;
  keyVersion: number;
  wrappedKey: Buffer;
  dekKeyId: string;
  createdAt: Date;
  destroyedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Injectable persistence interface
// ---------------------------------------------------------------------------

export interface SubjectDataKeyPrismaClient {
  subjectDataKey: {
    create(args: {
      data: {
        userId: string;
        keyVersion: number;
        wrappedKey: Buffer;
        dekKeyId: string;
      };
    }): Promise<SubjectDataKeyRow>;

    findFirst(args: {
      where: { userId: string; keyVersion?: number; destroyedAt?: null };
      orderBy?: { keyVersion: "desc" };
    }): Promise<SubjectDataKeyRow | null>;

    findMany(args: {
      where: { userId: string };
      orderBy?: { keyVersion: "desc" };
    }): Promise<SubjectDataKeyRow[]>;

    update(args: {
      where: { id: string };
      data: { destroyedAt: Date };
    }): Promise<SubjectDataKeyRow>;

    updateMany(args: {
      where: { userId: string; destroyedAt?: null };
      data: { destroyedAt: Date };
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// SubjectDataKeyRepository
// ---------------------------------------------------------------------------

export class SubjectDataKeyRepository {
  constructor(private readonly db: SubjectDataKeyPrismaClient) {}

  /**
   * Create a new versioned wrapped DEK for a subject.
   * Version is auto-incremented: max(existing) + 1, or 1 if none exist.
   */
  async create(
    userId: string,
    wrappedKey: WrappedKey,
  ): Promise<SubjectDataKeyRow> {
    const existing = await this.db.subjectDataKey.findMany({
      where: { userId },
      orderBy: { keyVersion: "desc" },
    });

    const nextVersion =
      existing.length > 0 ? (existing[0]!.keyVersion + 1) : 1;

    return this.db.subjectDataKey.create({
      data: {
        userId,
        keyVersion: nextVersion,
        wrappedKey: wrappedKey.wrappedDek,
        dekKeyId: wrappedKey.dekKeyId,
      },
    });
  }

  /**
   * Retrieve the active (non-destroyed) wrapped DEK for a subject.
   * Returns the highest key version that has not been destroyed.
   */
  async findActive(userId: string): Promise<SubjectDataKeyRow | null> {
    return this.db.subjectDataKey.findFirst({
      where: { userId, destroyedAt: null },
      orderBy: { keyVersion: "desc" },
    });
  }

  /**
   * Retrieve a specific key version for a subject.
   * Used during decryption when the stored keyVersion on a row points to a
   * specific version (supports reading ciphertext from older key versions).
   */
  async findByVersion(
    userId: string,
    keyVersion: number,
  ): Promise<SubjectDataKeyRow | null> {
    return this.db.subjectDataKey.findFirst({
      where: { userId, keyVersion },
    });
  }

  /**
   * Cryptographic erasure: mark all active keys for a subject as destroyed.
   *
   * After this call, any ciphertext encrypted under these keys is permanently
   * unrecoverable — KMS will refuse to decrypt a wrapped DEK whose entry has
   * destroyedAt set (enforced at the application layer).
   *
   * Returns the number of keys marked as destroyed.
   */
  async destroyAllForUser(userId: string): Promise<number> {
    const result = await this.db.subjectDataKey.updateMany({
      where: { userId, destroyedAt: null },
      data: { destroyedAt: new Date() },
    });
    return result.count;
  }

  /**
   * Cryptographic erasure: mark a specific key version as destroyed.
   * Used for targeted key rotation (destroy old version after re-encryption).
   */
  async destroyVersion(
    userId: string,
    keyVersion: number,
  ): Promise<SubjectDataKeyRow | null> {
    const row = await this.findByVersion(userId, keyVersion);
    if (!row) return null;

    return this.db.subjectDataKey.update({
      where: { id: row.id },
      data: { destroyedAt: new Date() },
    });
  }

  /**
   * Retrieve all key versions for a subject (for admin/audit view).
   */
  async findAllForUser(userId: string): Promise<SubjectDataKeyRow[]> {
    return this.db.subjectDataKey.findMany({
      where: { userId },
      orderBy: { keyVersion: "desc" },
    });
  }
}
