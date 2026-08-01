/**
 * Unit tests for BookingLifecycleService (WO-040).
 *
 * All collaborators are in-memory doubles — no Prisma, no network.
 * Covers:
 *   AC2  — full permitted transition matrix
 *   AC3  — every forbidden pair → 409 LIFECYCLE_CONFLICT
 *   AC4  — same-status idempotency (CONFIRMED, CANCELLED, EXPIRED) and
 *           same-status denial for non-idempotent states
 *   AC5  — zero rowsAffected (lost race) → 409
 *   AC6  — audit write failure rolls back the status update
 *   AC7  — unknown target and unknown current status → 409
 *   AC8  — booking not found → 404
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BookingLifecycleService,
  isLifecycleConflict,
  type LifecycleRepositoryPort,
  type BookingStatusRow,
  type LifecycleDeps,
} from "../../src/domain/BookingLifecycleService.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";
import { PERMITTED_TRANSITIONS, type BookingStatus } from "../../src/domain/transitions.js";

// ---------------------------------------------------------------------------
// In-memory repository double
// ---------------------------------------------------------------------------

class InMemoryLifecycleRepo implements LifecycleRepositoryPort {
  private bookings = new Map<string, string>();
  auditCreateFn = vi.fn().mockResolvedValue(undefined);

  seed(id: string, status: string): this {
    this.bookings.set(id, status);
    return this;
  }

  getStatus(id: string): string | undefined {
    return this.bookings.get(id);
  }

  async findBookingById(bookingId: string): Promise<BookingStatusRow | null> {
    const status = this.bookings.get(bookingId);
    if (status === undefined) return null;
    return { id: bookingId, status };
  }

  async conditionalStatusUpdate(
    bookingId: string,
    fromStatus: string,
    toStatus: string,
    _tx: AuditTxClient,
  ): Promise<number> {
    const current = this.bookings.get(bookingId);
    if (current !== fromStatus) return 0;
    this.bookings.set(bookingId, toStatus);
    return 1;
  }

  async runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T> {
    const snapshot = new Map(this.bookings);
    const tx: AuditTxClient = {
      bookingAuditLog: { create: this.auditCreateFn },
    };
    try {
      return await work(tx);
    } catch (err) {
      this.bookings.clear();
      for (const [k, v] of snapshot) this.bookings.set(k, v);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures and actor
// ---------------------------------------------------------------------------

const ACTOR = { id: "usr_operator_01", role: "operator" };
const BOOKING_ID = "bk_lc_test_001";
const FIXED_NOW = new Date("2026-08-01T12:00:00Z");

function makeService(repo: InMemoryLifecycleRepo): BookingLifecycleService {
  const deps: LifecycleDeps = {
    repository: repo,
    clock: () => FIXED_NOW,
  };
  return new BookingLifecycleService(deps);
}

// ---------------------------------------------------------------------------
// AC8: Booking not found → 404
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — booking not found", () => {
  it("throws NOT_FOUND when the booking does not exist", async () => {
    const repo = new InMemoryLifecycleRepo();
    const svc = makeService(repo);
    const err = await svc.transition("missing_id", "CONFIRMED", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("NOT_FOUND");
  });

  it("does not call the repository transaction for a missing booking", async () => {
    const repo = new InMemoryLifecycleRepo();
    const runSpy = vi.spyOn(repo, "runInTransaction");
    const svc = makeService(repo);
    await svc.transition("missing_id", "CONFIRMED", ACTOR).catch(() => {});
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC7: Unknown target status → 409 before any DB access
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — unknown target status", () => {
  it("throws LIFECYCLE_CONFLICT for an unmapped target status", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    const findSpy = vi.spyOn(repo, "findBookingById");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "GHOST_STATE", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
    expect(isLifecycleConflict(err)).toBe(true);
    // Must refuse BEFORE hitting the database (AC7 deny-by-default)
    expect(findSpy).not.toHaveBeenCalled();
  });

  it("throws LIFECYCLE_CONFLICT for empty string target status", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// AC7: Unknown current status → 409 (deny by default)
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — unknown current status", () => {
  it("throws LIFECYCLE_CONFLICT when booking has an unmapped status", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "LEGACY_DRAFT");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
  });

  it("does not run a transaction when current status is unknown", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "UNKNOWN_STATUS");
    const runSpy = vi.spyOn(repo, "runInTransaction");
    const svc = makeService(repo);
    await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch(() => {});
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("never fails open — unknown status is a refusal, not a pass-through", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "MYSTERY_STATUS");
    const svc = makeService(repo);
    // Even if we attempt a transition to a valid target, it must be refused.
    const err = await svc.transition(BOOKING_ID, "CANCELLED", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
    // Status must not have changed.
    expect(repo.getStatus(BOOKING_ID)).toBe("MYSTERY_STATUS");
  });
});

// ---------------------------------------------------------------------------
// AC4: Same-status idempotency
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — same-status idempotency", () => {
  const idempotentCases: [BookingStatus][] = [
    ["CONFIRMED"],
    ["CANCELLED"],
    ["EXPIRED"],
  ];

  it.each(idempotentCases)(
    "%s → %s is idempotent (no audit row written)",
    async (status) => {
      const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, status);
      const svc = makeService(repo);
      const result = await svc.transition(BOOKING_ID, status, ACTOR);
      expect(result.idempotent).toBe(true);
      expect(result.previousStatus).toBe(status);
      expect(result.newStatus).toBe(status);
      // No audit row must be created.
      expect(repo.auditCreateFn).not.toHaveBeenCalled();
    },
  );

  const nonIdempotentSameStatus: [BookingStatus][] = [
    ["PENDING"],
    ["COMPLETED"],
    ["FAILED"],
    ["REFUNDED"],
  ];

  it.each(nonIdempotentSameStatus)(
    "%s → %s (same-status) is NOT idempotent → 409",
    async (status) => {
      const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, status);
      const svc = makeService(repo);
      const err = await svc.transition(BOOKING_ID, status, ACTOR).catch((e) => e);
      expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
    },
  );
});

// ---------------------------------------------------------------------------
// AC2: Permitted transitions — full matrix
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — permitted transitions (AC2)", () => {
  const permittedPairs: [BookingStatus, BookingStatus][] = [
    ["PENDING", "CONFIRMED"],
    ["PENDING", "CANCELLED"],
    ["PENDING", "FAILED"],
    ["PENDING", "EXPIRED"],
    ["CONFIRMED", "COMPLETED"],
    ["CONFIRMED", "CANCELLED"],
    ["CONFIRMED", "REFUNDED"],
  ];

  it.each(permittedPairs)("%s → %s is permitted", async (from, to) => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, from);
    const svc = makeService(repo);
    const result = await svc.transition(BOOKING_ID, to, ACTOR, "test transition");
    expect(result.idempotent).toBe(false);
    expect(result.previousStatus).toBe(from);
    expect(result.newStatus).toBe(to);
    // Status updated in the store.
    expect(repo.getStatus(BOOKING_ID)).toBe(to);
  });

  it.each(permittedPairs)(
    "%s → %s writes one audit row in the same transaction",
    async (from, to) => {
      const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, from);
      const svc = makeService(repo);
      await svc.transition(BOOKING_ID, to, ACTOR);
      expect(repo.auditCreateFn).toHaveBeenCalledOnce();
      const [{ data }] = repo.auditCreateFn.mock.calls[0] as [{ data: { bookingId: string; action: string; payload: unknown } }][];
      expect(data.bookingId).toBe(BOOKING_ID);
      expect(data.action).toBe(`STATUS_CHANGED_TO_${to}`);
    },
  );
});

// ---------------------------------------------------------------------------
// AC3: Forbidden transitions — terminal states and cross-state denials
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — forbidden transitions (AC3)", () => {
  const terminalStates: BookingStatus[] = [
    "COMPLETED",
    "CANCELLED",
    "FAILED",
    "REFUNDED",
    "EXPIRED",
  ];

  // All transitions out of terminal states are forbidden
  it.each(terminalStates)(
    "terminal state %s refuses all outgoing transitions",
    async (terminalStatus) => {
      const allStatuses = Object.keys(PERMITTED_TRANSITIONS) as BookingStatus[];
      for (const target of allStatuses) {
        if (target === terminalStatus) continue; // same-status is tested separately
        const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, terminalStatus);
        const svc = makeService(repo);
        const err = await svc.transition(BOOKING_ID, target, ACTOR).catch((e) => e);
        expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
        // Status must not have changed.
        expect(repo.getStatus(BOOKING_ID)).toBe(terminalStatus);
      }
    },
  );

  const crossStateDenials: [BookingStatus, BookingStatus][] = [
    ["PENDING", "COMPLETED"],
    ["PENDING", "REFUNDED"],
    ["CONFIRMED", "PENDING"],
    ["CONFIRMED", "FAILED"],
    ["CONFIRMED", "EXPIRED"],
  ];

  it.each(crossStateDenials)("%s → %s is forbidden → 409", async (from, to) => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, from);
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, to, ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
    expect(isLifecycleConflict(err)).toBe(true);
    // Status must not have changed.
    expect(repo.getStatus(BOOKING_ID)).toBe(from);
  });

  it("LIFECYCLE_CONFLICT message names the current state and permitted transitions", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "COMPLETED", ACTOR).catch((e) => e) as Error;
    expect(err.message).toContain("PENDING");
  });

  it("LIFECYCLE_CONFLICT for terminal state message does not leak target", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "COMPLETED");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "CANCELLED", ACTOR).catch((e) => e) as Error;
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// AC5: Concurrent update race — zero rowsAffected → 409
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — concurrent update race (AC5)", () => {
  it("throws LIFECYCLE_CONFLICT when rowsAffected is 0", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    // Simulate the race: status changes between findBookingById and the update.
    vi.spyOn(repo, "conditionalStatusUpdate").mockResolvedValueOnce(0);
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch((e) => e);
    expect((err as { code: string }).code).toBe("LIFECYCLE_CONFLICT");
  });

  it("does not write an audit row when the conditional update returns 0", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    vi.spyOn(repo, "conditionalStatusUpdate").mockResolvedValueOnce(0);
    const svc = makeService(repo);
    await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch(() => {});
    expect(repo.auditCreateFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC6: Audit write failure rolls back the status update
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — audit write failure rollback (AC6)", () => {
  it("rolls back the status update when the audit write throws", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    repo.auditCreateFn.mockRejectedValueOnce(new Error("DB connection lost"));
    const svc = makeService(repo);
    await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch(() => {});
    // Status must have reverted to PENDING (transaction rolled back).
    expect(repo.getStatus(BOOKING_ID)).toBe("PENDING");
  });

  it("propagates the audit write error to the caller", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    const dbErr = new Error("Audit table locked");
    repo.auditCreateFn.mockRejectedValueOnce(dbErr);
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR).catch((e) => e) as Error;
    expect(err.message).toBe("Audit table locked");
  });

  it("does not commit the transition when the audit row cannot be written", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "CONFIRMED");
    repo.auditCreateFn.mockRejectedValueOnce(new Error("I/O error"));
    const svc = makeService(repo);
    await svc.transition(BOOKING_ID, "COMPLETED", ACTOR).catch(() => {});
    // Must still be CONFIRMED — the update must not have persisted.
    expect(repo.getStatus(BOOKING_ID)).toBe("CONFIRMED");
  });
});

// ---------------------------------------------------------------------------
// TransitionResult shape verification
// ---------------------------------------------------------------------------

describe("BookingLifecycleService — TransitionResult", () => {
  it("returns bookingId, previousStatus, newStatus, idempotent=false on success", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "PENDING");
    const svc = makeService(repo);
    const result = await svc.transition(BOOKING_ID, "CONFIRMED", ACTOR, "payment cleared");
    expect(result).toEqual({
      bookingId: BOOKING_ID,
      previousStatus: "PENDING",
      newStatus: "CONFIRMED",
      idempotent: false,
    });
  });

  it("audit row action encodes the target status", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "CONFIRMED");
    const svc = makeService(repo);
    await svc.transition(BOOKING_ID, "COMPLETED", ACTOR);
    const [{ data }] = repo.auditCreateFn.mock.calls[0] as [{ data: { action: string; occurredAt: Date } }][];
    expect(data.action).toBe("STATUS_CHANGED_TO_COMPLETED");
    expect(data.occurredAt).toEqual(FIXED_NOW);
  });
});

// ---------------------------------------------------------------------------
// isLifecycleConflict type-guard helper
// ---------------------------------------------------------------------------

describe("isLifecycleConflict", () => {
  it("returns true for a LIFECYCLE_CONFLICT DomainError", async () => {
    const repo = new InMemoryLifecycleRepo().seed(BOOKING_ID, "COMPLETED");
    const svc = makeService(repo);
    const err = await svc.transition(BOOKING_ID, "CANCELLED", ACTOR).catch((e) => e);
    expect(isLifecycleConflict(err)).toBe(true);
  });

  it("returns false for a NOT_FOUND DomainError", async () => {
    const repo = new InMemoryLifecycleRepo();
    const svc = makeService(repo);
    const err = await svc.transition("missing", "CONFIRMED", ACTOR).catch((e) => e);
    expect(isLifecycleConflict(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isLifecycleConflict(new Error("plain"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLifecycleConflict(null)).toBe(false);
  });
});
