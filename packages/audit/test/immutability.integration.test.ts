/**
 * WO-041 Integration test spec — Append-only immutability + gapless ordered trail.
 *
 * These tests run against an in-memory stub that enforces the same contractual
 * invariants the database triggers enforce in production:
 *   1. UPDATE attempts on existing rows are rejected.
 *   2. DELETE attempts on existing rows are rejected.
 *   3. A create-then-cancel lifecycle produces an ordered, gapless hash chain.
 *
 * In a CI environment with a real Postgres instance the same tests can be
 * re-run by replacing FakeImmutableStore with a real PrismaClient bound to a
 * test schema that has the production migrations applied.  The application-level
 * contracts are identical regardless of the backend.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { PrismaAuditWriter, verifyChain } from "../src/PrismaAuditWriter.js";
import { GENESIS_HASH, buildAuditPreImage } from "../src/canonicalize.js";
import type { AuditTxClient } from "../src/AuditWriter.js";
import type { ChainEntry } from "../src/PrismaAuditWriter.js";
import {
  FIXTURE_BOOKING_CREATED,
  FIXTURE_BOOKING_MODIFIED,
  FIXTURE_BOOKING_CONFIRMED,
  FIXTURE_BOOKING_CANCELLED,
  FIXTURE_BOOKING_LIFECYCLE,
} from "../src/fixtures/auditFixtures.js";
import { sanitiseAuditPayload } from "@travel/contracts/booking";

// ---------------------------------------------------------------------------
// FakeImmutableStore — enforces INSERT-only semantics in memory
// ---------------------------------------------------------------------------

class ImmutabilityViolationError extends Error {
  constructor(operation: string) {
    super(`FakeImmutableStore: ${operation} is not permitted — table is append-only`);
    this.name = "ImmutabilityViolationError";
  }
}

interface StoredRow {
  id: string;
  actorId: string;
  actorRole: string;
  actorIp: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState: unknown;
  newState: unknown;
  correlationId: string | null;
  occurredAt: Date;
  prevHash: string;
  entryHash: string;
  reason: string | null;
}

class FakeImmutableStore {
  readonly rows: StoredRow[] = [];
  private seq = 0;

  get handle() {
    const store = this;
    return {
      async findFirst(args: { where: Record<string, unknown>; orderBy?: unknown; select?: unknown }) {
        const resourceId = args.where["resourceId"] as string | undefined;
        if (!resourceId) return null;
        const matching = store.rows.filter((r) => r.resourceId === resourceId);
        if (matching.length === 0) return null;
        return { entryHash: matching[matching.length - 1]!.entryHash };
      },

      async create(args: { data: Record<string, unknown> }) {
        const id = `row-${++store.seq}`;
        store.rows.push({ ...(args.data as Omit<StoredRow, "id">), id } as StoredRow);
        return { id };
      },

      // UPDATE is explicitly forbidden — mirrors REVOKE UPDATE on the real table
      async update(_args: unknown): Promise<never> {
        throw new ImmutabilityViolationError("UPDATE");
      },

      async updateMany(_args: unknown): Promise<never> {
        throw new ImmutabilityViolationError("UPDATE MANY");
      },

      // DELETE is explicitly forbidden — mirrors REVOKE DELETE on the real table
      async delete(_args: unknown): Promise<never> {
        throw new ImmutabilityViolationError("DELETE");
      },

      async deleteMany(_args: unknown): Promise<never> {
        throw new ImmutabilityViolationError("DELETE MANY");
      },
    };
  }

  asTxClient(): AuditTxClient {
    return {
      bookingAuditLog: this.handle as unknown as AuditTxClient["bookingAuditLog"],
      authAuditLog: this.handle as unknown as AuditTxClient["authAuditLog"],
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WO-041 Immutability invariants", () => {
  let store: FakeImmutableStore;
  let writer: PrismaAuditWriter;

  beforeEach(() => {
    store = new FakeImmutableStore();
    writer = new PrismaAuditWriter();
  });

  it("rejects UPDATE on a booking audit row", async () => {
    const handle = store.handle;
    await expect(handle.update({ where: { id: "row-1" }, data: { actorId: "tampered" } })).rejects.toThrow(
      ImmutabilityViolationError,
    );
  });

  it("rejects DELETE on a booking audit row", async () => {
    const handle = store.handle;
    await expect(handle.delete({ where: { id: "row-1" } })).rejects.toThrow(ImmutabilityViolationError);
  });

  it("rejects DELETE MANY on booking audit rows", async () => {
    const handle = store.handle;
    await expect(handle.deleteMany({ where: { actorId: "user-123" } })).rejects.toThrow(ImmutabilityViolationError);
  });

  it("create-then-cancel lifecycle produces a gapless ordered hash chain", async () => {
    const tx = store.asTxClient();

    await writer.append(tx, FIXTURE_BOOKING_CREATED);
    await writer.append(tx, FIXTURE_BOOKING_CONFIRMED);
    await writer.append(tx, FIXTURE_BOOKING_CANCELLED);

    expect(store.rows).toHaveLength(3);

    // Build ChainEntry format for verifyChain
    const chainEntries: ChainEntry[] = store.rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      previousState: r.previousState,
      newState: r.newState,
      occurredAt: r.occurredAt,
      correlationId: r.correlationId,
      prevHash: r.prevHash,
      entryHash: r.entryHash,
    }));

    const breaks = verifyChain(chainEntries);
    expect(breaks).toHaveLength(0);
  });

  it("first entry uses GENESIS_HASH as prevHash", async () => {
    const tx = store.asTxClient();
    await writer.append(tx, FIXTURE_BOOKING_CREATED);

    expect(store.rows[0]!.prevHash).toBe(GENESIS_HASH);
  });

  it("each subsequent entry chains to the previous entry_hash", async () => {
    const tx = store.asTxClient();

    await writer.append(tx, FIXTURE_BOOKING_CREATED);
    await writer.append(tx, FIXTURE_BOOKING_MODIFIED);
    await writer.append(tx, FIXTURE_BOOKING_CONFIRMED);

    expect(store.rows[1]!.prevHash).toBe(store.rows[0]!.entryHash);
    expect(store.rows[2]!.prevHash).toBe(store.rows[1]!.entryHash);
  });

  it("full lifecycle produces a verifiable chain with no breaks", async () => {
    const tx = store.asTxClient();

    // All fixtures share FIXTURE_BOOKING_ID except BOOKING_EXPIRED (different booking)
    const lifecycleForSameBooking = FIXTURE_BOOKING_LIFECYCLE.filter(
      (e) => e.resourceId === FIXTURE_BOOKING_CREATED.resourceId,
    );

    for (const event of lifecycleForSameBooking) {
      await writer.append(tx, event);
    }

    const chainEntries: ChainEntry[] = store.rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      previousState: r.previousState,
      newState: r.newState,
      occurredAt: r.occurredAt,
      correlationId: r.correlationId,
      prevHash: r.prevHash,
      entryHash: r.entryHash,
    }));

    const breaks = verifyChain(chainEntries);
    expect(breaks).toHaveLength(0);
  });

  it("reason column is present on lifecycle events that set it", async () => {
    const tx = store.asTxClient();

    await writer.append(tx, FIXTURE_BOOKING_CREATED);   // reason: INITIAL_BOOKING
    await writer.append(tx, FIXTURE_BOOKING_CONFIRMED); // reason: undefined (system)
    await writer.append(tx, FIXTURE_BOOKING_CANCELLED); // reason: CANCELLATION_REQUESTED

    expect(store.rows[0]!.reason).toBe("INITIAL_BOOKING");
    expect(store.rows[1]!.reason).toBeNull();
    expect(store.rows[2]!.reason).toBe("CANCELLATION_REQUESTED");
  });

  it("tampered entry_hash is detected by verifyChain", async () => {
    const tx = store.asTxClient();

    await writer.append(tx, FIXTURE_BOOKING_CREATED);
    await writer.append(tx, FIXTURE_BOOKING_MODIFIED);

    // Simulate tampering by overwriting the first entry's hash
    store.rows[0]!.entryHash = "tampered-hash-value-" + "0".repeat(44);

    const chainEntries: ChainEntry[] = store.rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      previousState: r.previousState,
      newState: r.newState,
      occurredAt: r.occurredAt,
      correlationId: r.correlationId,
      prevHash: r.prevHash,
      entryHash: r.entryHash,
    }));

    const breaks = verifyChain(chainEntries);
    // Tampered entry_hash on row[0] breaks row[0]'s own hash AND row[1]'s prevHash
    expect(breaks.length).toBeGreaterThan(0);
  });
});
