/**
 * Unit tests for SubjectDataKeyRepository (WO-104 AC2).
 *
 * Verifies:
 *   - Key creation with auto-incremented version
 *   - Active key lookup returns highest non-destroyed version
 *   - findByVersion resolves specific key version
 *   - destroyAllForUser marks all active keys as destroyed
 *   - destroyVersion marks a specific version as destroyed
 *   - Destroyed key is excluded from findActive (cryptographic erasure proven)
 *   - Multiple key versions coexist (rotation support)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SubjectDataKeyRepository,
} from "../../src/repositories/SubjectDataKeyRepository.js";
import type {
  SubjectDataKeyRow,
  SubjectDataKeyPrismaClient,
} from "../../src/repositories/SubjectDataKeyRepository.js";

// ---------------------------------------------------------------------------
// In-memory mock Prisma client
// ---------------------------------------------------------------------------

function makeMockKeyDb(): SubjectDataKeyPrismaClient & { _rows: SubjectDataKeyRow[] } {
  const rows: SubjectDataKeyRow[] = [];
  let idCounter = 1;

  return {
    _rows: rows,
    subjectDataKey: {
      async create({ data }) {
        const row: SubjectDataKeyRow = {
          id: `sdk-${idCounter++}`,
          userId: data.userId,
          keyVersion: data.keyVersion,
          wrappedKey: data.wrappedKey,
          dekKeyId: data.dekKeyId,
          createdAt: new Date(),
          destroyedAt: null,
        };
        rows.push(row);
        return row;
      },

      async findFirst({ where, orderBy }) {
        let matches = rows.filter(r => {
          if (r.userId !== where.userId) return false;
          if (where.keyVersion !== undefined && r.keyVersion !== where.keyVersion) return false;
          if (where.destroyedAt === null && r.destroyedAt !== null) return false;
          return true;
        });
        if (orderBy?.keyVersion === "desc") {
          matches = matches.sort((a, b) => b.keyVersion - a.keyVersion);
        }
        return matches[0] ?? null;
      },

      async findMany({ where, orderBy }) {
        let matches = rows.filter(r => r.userId === where.userId);
        if (orderBy?.keyVersion === "desc") {
          matches = matches.sort((a, b) => b.keyVersion - a.keyVersion);
        }
        return matches;
      },

      async update({ where, data }) {
        const row = rows.find(r => r.id === where.id);
        if (!row) throw new Error(`Row not found: ${where.id}`);
        row.destroyedAt = data.destroyedAt;
        return row;
      },

      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows) {
          if (row.userId !== where.userId) continue;
          if (where.destroyedAt === null && row.destroyedAt !== null) continue;
          row.destroyedAt = data.destroyedAt;
          count++;
        }
        return { count };
      },
    },
  };
}

const FAKE_WRAPPED_KEY = {
  wrappedDek: Buffer.from("fake-wrapped-dek-bytes", "utf8"),
  dekKeyId: "arn:aws:kms:us-east-1:123456789012:key/test-key-id",
};

const FAKE_WRAPPED_KEY_2 = {
  wrappedDek: Buffer.from("fake-wrapped-dek-v2", "utf8"),
  dekKeyId: "arn:aws:kms:us-east-1:123456789012:key/test-key-id-v2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubjectDataKeyRepository", () => {
  let db: ReturnType<typeof makeMockKeyDb>;
  let repo: SubjectDataKeyRepository;

  beforeEach(() => {
    db = makeMockKeyDb();
    repo = new SubjectDataKeyRepository(db);
  });

  it("create() assigns key version 1 for a new subject", async () => {
    const row = await repo.create("user-001", FAKE_WRAPPED_KEY);

    expect(row.keyVersion).toBe(1);
    expect(row.userId).toBe("user-001");
    expect(row.wrappedKey.toString("utf8")).toBe("fake-wrapped-dek-bytes");
    expect(row.destroyedAt).toBeNull();
  });

  it("create() auto-increments key version for rotation (AC9)", async () => {
    await repo.create("user-002", FAKE_WRAPPED_KEY);
    const v2 = await repo.create("user-002", FAKE_WRAPPED_KEY_2);

    expect(v2.keyVersion).toBe(2);
  });

  it("findActive() returns the highest non-destroyed key version", async () => {
    await repo.create("user-003", FAKE_WRAPPED_KEY);       // version 1
    await repo.create("user-003", FAKE_WRAPPED_KEY_2);     // version 2

    const active = await repo.findActive("user-003");

    expect(active).not.toBeNull();
    expect(active!.keyVersion).toBe(2);
  });

  it("findByVersion() returns a specific key version", async () => {
    await repo.create("user-004", FAKE_WRAPPED_KEY);
    await repo.create("user-004", FAKE_WRAPPED_KEY_2);

    const v1 = await repo.findByVersion("user-004", 1);
    const v2 = await repo.findByVersion("user-004", 2);

    expect(v1).not.toBeNull();
    expect(v1!.keyVersion).toBe(1);
    expect(v2).not.toBeNull();
    expect(v2!.keyVersion).toBe(2);
  });

  it("findByVersion() returns null for a non-existent version", async () => {
    await repo.create("user-005", FAKE_WRAPPED_KEY);

    const missing = await repo.findByVersion("user-005", 99);
    expect(missing).toBeNull();
  });

  it("destroyAllForUser() marks all active keys as destroyed (AC2 cryptographic erasure)", async () => {
    await repo.create("user-006", FAKE_WRAPPED_KEY);
    await repo.create("user-006", FAKE_WRAPPED_KEY_2);

    const destroyedCount = await repo.destroyAllForUser("user-006");

    expect(destroyedCount).toBe(2);

    // findActive must return null after destruction
    const active = await repo.findActive("user-006");
    expect(active).toBeNull();

    // All versions should have destroyedAt set
    const allKeys = await repo.findAllForUser("user-006");
    for (const key of allKeys) {
      expect(key.destroyedAt).not.toBeNull();
    }
  });

  it("destroyVersion() marks a single version as destroyed (AC9 targeted rotation)", async () => {
    await repo.create("user-007", FAKE_WRAPPED_KEY);       // v1
    await repo.create("user-007", FAKE_WRAPPED_KEY_2);     // v2

    const destroyed = await repo.destroyVersion("user-007", 1);

    expect(destroyed).not.toBeNull();
    expect(destroyed!.keyVersion).toBe(1);
    expect(destroyed!.destroyedAt).not.toBeNull();

    // v2 must still be active
    const active = await repo.findActive("user-007");
    expect(active).not.toBeNull();
    expect(active!.keyVersion).toBe(2);
    expect(active!.destroyedAt).toBeNull();
  });

  it("destroyVersion() returns null for non-existent version", async () => {
    const result = await repo.destroyVersion("user-008", 99);
    expect(result).toBeNull();
  });

  it("finding active key returns null when no keys exist for user", async () => {
    const active = await repo.findActive("no-such-user");
    expect(active).toBeNull();
  });

  it("key registry is per-user: different users have independent version counters", async () => {
    const userA_v1 = await repo.create("user-A", FAKE_WRAPPED_KEY);
    const userA_v2 = await repo.create("user-A", FAKE_WRAPPED_KEY_2);
    const userB_v1 = await repo.create("user-B", FAKE_WRAPPED_KEY);

    expect(userA_v1.keyVersion).toBe(1);
    expect(userA_v2.keyVersion).toBe(2);
    expect(userB_v1.keyVersion).toBe(1); // user B starts at 1 independently

    // Destroying user A's keys does not affect user B
    await repo.destroyAllForUser("user-A");
    const userBActive = await repo.findActive("user-B");
    expect(userBActive).not.toBeNull();
  });
});
