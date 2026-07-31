import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { PrismaAuditWriter } from "../src/PrismaAuditWriter.js";
import { canonicalize, GENESIS_HASH } from "../src/canonicalize.js";
import type { AuditTxClient } from "../src/AuditWriter.js";

// ---------------------------------------------------------------------------
// In-memory double for AuditTxClient
// ---------------------------------------------------------------------------

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
}

function makeClient(): { client: AuditTxClient; rows: StoredRow[] } {
  const rows: StoredRow[] = [];
  let seq = 0;

  const client: AuditTxClient = {
    bookingAuditLog: {
      async findFirst(args) {
        const { where } = args;
        const resourceId = where["resourceId"] as string | undefined;
        if (!resourceId) return null;
        const matching = rows.filter((r) => r.resourceId === resourceId && r.action.startsWith("BOOKING_"));
        if (matching.length === 0) return null;
        // Return last inserted (simulated "orderBy occurred_at desc")
        return { entryHash: matching[matching.length - 1]!.entryHash };
      },
      async create(args) {
        const id = `booking-audit-${++seq}`;
        rows.push({ ...(args.data as Omit<StoredRow, "id">), id } as StoredRow);
        return { id };
      },
    },
    authAuditLog: {
      async findFirst(args) {
        const { where } = args;
        const resourceId = where["resourceId"] as string | undefined;
        if (!resourceId) return null;
        const matching = rows.filter((r) => r.resourceId === resourceId && r.action.startsWith("AUTH_"));
        if (matching.length === 0) return null;
        return { entryHash: matching[matching.length - 1]!.entryHash };
      },
      async create(args) {
        const id = `auth-audit-${++seq}`;
        rows.push({ ...(args.data as Omit<StoredRow, "id">), id } as StoredRow);
        return { id };
      },
    },
  };

  return { client, rows };
}

// ---------------------------------------------------------------------------
// Helper: recompute entry_hash for a given row and its predecessor hash
// ---------------------------------------------------------------------------

function recomputeHash(row: StoredRow, prevHash: string): string {
  const preImage = canonicalize({
    actorId: row.actorId,
    actorRole: row.actorRole,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    previousState: row.previousState,
    newState: row.newState,
    occurredAt: row.occurredAt.toISOString(),
    correlationId: row.correlationId,
  }) + prevHash;
  return createHash("sha256").update(preImage, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrismaAuditWriter", () => {
  let writer: PrismaAuditWriter;

  beforeEach(() => {
    writer = new PrismaAuditWriter();
  });

  it("appends a booking audit row and returns auditId + entryHash", async () => {
    const { client, rows } = makeClient();

    const result = await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
      newState: { status: "PENDING" },
    });

    expect(result.auditId).toMatch(/^booking-audit-/);
    expect(result.entryHash).toHaveLength(64);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("BOOKING_CREATED");
  });

  it("uses GENESIS_HASH as prevHash for the first entry", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
    });

    expect(rows[0]!.prevHash).toBe(GENESIS_HASH);
  });

  it("chains entry_hash of first row as prevHash of second row", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
    });

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CONFIRMED",
      resourceType: "booking",
      resourceId: "booking-abc",
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]!.prevHash).toBe(rows[0]!.entryHash);
  });

  it("entry_hash is the SHA-256 of canonical(payload)+prevHash", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
      newState: { status: "PENDING" },
    });

    const row = rows[0]!;
    const expected = recomputeHash(row, GENESIS_HASH);
    expect(row.entryHash).toBe(expected);
  });

  it("routes AUTH_ actions to authAuditLog", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "AUTH_LOGIN_SUCCESS",
      resourceType: "session",
      resourceId: "user-123",
    });

    expect(rows[0]!.id).toMatch(/^auth-audit-/);
    expect(rows[0]!.action).toBe("AUTH_LOGIN_SUCCESS");
  });

  it("redacts sensitive fields from previousState before persisting", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
      previousState: {
        email: "user@example.com",
        passportNumber: "AB123456",
        dateOfBirth: "1990-01-01",
        status: "active",
      },
    });

    const stored = rows[0]!.previousState as Record<string, unknown>;
    expect(stored["email"]).toBe("[REDACTED]");
    expect(stored["passportNumber"]).toBe("[REDACTED]");
    expect(stored["dateOfBirth"]).toBe("[REDACTED]");
    expect(stored["status"]).toBe("active");
  });

  it("redacts sensitive fields from newState before persisting", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CONFIRMED",
      resourceType: "booking",
      resourceId: "booking-abc",
      newState: {
        passwordHash: "hashed",
        accessToken: "secret-token",
        status: "CONFIRMED",
      },
    });

    const stored = rows[0]!.newState as Record<string, unknown>;
    expect(stored["passwordHash"]).toBe("[REDACTED]");
    expect(stored["accessToken"]).toBe("[REDACTED]");
    expect(stored["status"]).toBe("CONFIRMED");
  });

  it("uses provided occurredAt instead of Date.now()", async () => {
    const { client, rows } = makeClient();
    const fixedDate = new Date("2024-06-15T12:00:00.000Z");

    await writer.append(client, {
      actorId: "system",
      actorRole: "system",
      action: "BOOKING_EXPIRED",
      resourceType: "booking",
      resourceId: "booking-xyz",
      occurredAt: fixedDate,
    });

    expect(rows[0]!.occurredAt).toStrictEqual(fixedDate);
  });

  it("stores correlationId when provided", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CANCELLED",
      resourceType: "booking",
      resourceId: "booking-abc",
      correlationId: "trace-abc-123",
    });

    expect(rows[0]!.correlationId).toBe("trace-abc-123");
  });

  it("stores null correlationId when not provided", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-123",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-abc",
    });

    expect(rows[0]!.correlationId).toBeNull();
  });

  it("entries for different resourceIds have independent chains", async () => {
    const { client, rows } = makeClient();

    await writer.append(client, {
      actorId: "user-1",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-A",
    });

    await writer.append(client, {
      actorId: "user-2",
      actorRole: "traveler",
      action: "BOOKING_CREATED",
      resourceType: "booking",
      resourceId: "booking-B",
    });

    // Both entries use GENESIS_HASH as prevHash since they're independent streams
    expect(rows[0]!.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]!.prevHash).toBe(GENESIS_HASH);
  });
});
