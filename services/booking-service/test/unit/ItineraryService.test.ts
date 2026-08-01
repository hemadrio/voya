/**
 * Unit tests for ItineraryService (WO-053).
 *
 * All collaborators are in-memory doubles — no Prisma, no network.
 * Covers:
 *   AC1  — minimum-two booking ids at creation
 *   AC3  — 404 for non-existent, 403 for existing but other-owned
 *   AC4  — ownership predicate on every read/write
 *   AC5  — attach of foreign booking returns 403 + security audit
 *   AC6  — per-currency totals with no cross-currency summing
 *   AC7  — PATCH lifecycle conflicts (below-min detach, already-elsewhere)
 *   AC8  — DELETE detaches bookings without deleting them; audit written
 *   AC9  — date-validation (endDate before startDate)
 *   AC11 — domain service coverage: all rule branches
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ItineraryService,
  type Actor,
  type CreateItineraryInput,
  type UpdateItineraryInput,
} from "../../src/domain/ItineraryService.js";
import type {
  ItineraryRepositoryPort,
  ItineraryRow,
  ItineraryBookingRow,
  CreateItineraryData,
  UpdateItineraryData,
} from "../../src/repositories/ItineraryRepository.js";
import type { SecurityEventWriter } from "../../src/domain/SecurityEventWriter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_A = "usr_a_001";
const USER_B = "usr_b_001";
const ITN_ID = "itn_001";
const BK_1 = "bk_001";
const BK_2 = "bk_002";
const BK_3 = "bk_003";

const ACTOR_A: Actor = { id: USER_A, role: "traveler" };
const ACTOR_B: Actor = { id: USER_B, role: "traveler" };

const FIXED_NOW = new Date("2026-08-01T12:00:00Z");
const START = new Date("2026-09-01T00:00:00Z");
const END = new Date("2026-09-10T00:00:00Z");

function makeBookingRow(
  id: string,
  userId: string,
  currency: string,
  price: string,
  itineraryId: string | null = null,
): ItineraryBookingRow {
  return {
    id,
    userId,
    bookingType: "FLIGHT",
    status: "PENDING",
    totalPrice: { toString: () => price } as ItineraryBookingRow["totalPrice"],
    currency,
    itineraryId,
  };
}

function makeItineraryRow(overrides: Partial<ItineraryRow> = {}): ItineraryRow {
  return {
    id: ITN_ID,
    userId: USER_A,
    name: "Summer Trip",
    description: null,
    startDate: START,
    endDate: END,
    version: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    bookings: [
      makeBookingRow(BK_1, USER_A, "USD", "200.00"),
      makeBookingRow(BK_2, USER_A, "USD", "150.00"),
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory repository double
// ---------------------------------------------------------------------------

class InMemoryItineraryRepo implements ItineraryRepositoryPort {
  private rows = new Map<string, ItineraryRow>();
  private bookings = new Map<string, ItineraryBookingRow>();
  createCallCount = 0;
  updateCallCount = 0;
  deleteCallCount = 0;

  seed(row: ItineraryRow): this {
    this.rows.set(row.id, { ...row, bookings: [...row.bookings] });
    return this;
  }

  seedBooking(b: ItineraryBookingRow): this {
    this.bookings.set(b.id, { ...b });
    return this;
  }

  async findById(id: string): Promise<ItineraryRow | null> {
    return this.rows.get(id) ?? null;
  }

  async findOwnedById(id: string, userId: string): Promise<ItineraryRow | null> {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId) return null;
    return row;
  }

  async findAllByUser(userId: string): Promise<ItineraryRow[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }

  async create(
    data: CreateItineraryData,
    bookingIds: string[],
    userId: string,
  ): Promise<ItineraryRow> {
    this.createCallCount++;
    const row: ItineraryRow = {
      id: `itn_new_${this.createCallCount}`,
      userId: data.userId,
      name: data.name,
      description: data.description ?? null,
      startDate: data.startDate,
      endDate: data.endDate,
      version: 0,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      bookings: bookingIds.map((id) => this.bookings.get(id)!).filter(Boolean),
    };
    this.rows.set(row.id, row);
    // Attach bookings
    for (const id of bookingIds) {
      const b = this.bookings.get(id);
      if (b) this.bookings.set(id, { ...b, itineraryId: row.id });
    }
    return row;
  }

  async update(
    id: string,
    userId: string,
    expectedVersion: number,
    fields: UpdateItineraryData,
    addBookingIds: string[],
    removeBookingIds: string[],
  ): Promise<ItineraryRow | null> {
    this.updateCallCount++;
    const row = this.rows.get(id);
    if (!row || row.version !== expectedVersion) return null;

    const updated: ItineraryRow = {
      ...row,
      name: fields.name ?? row.name,
      description: 'description' in fields ? (fields.description ?? null) : row.description,
      startDate: fields.startDate ?? row.startDate,
      endDate: fields.endDate ?? row.endDate,
      version: row.version + 1,
      updatedAt: FIXED_NOW,
      bookings: [
        ...row.bookings.filter((b) => !removeBookingIds.includes(b.id)),
        ...addBookingIds
          .map((bid) => this.bookings.get(bid))
          .filter((b): b is ItineraryBookingRow => b !== undefined),
      ],
    };
    this.rows.set(id, updated);
    return updated;
  }

  async deleteById(id: string, _userId: string): Promise<void> {
    this.deleteCallCount++;
    const row = this.rows.get(id);
    if (row) {
      // Detach bookings
      for (const b of row.bookings) {
        const bRow = this.bookings.get(b.id);
        if (bRow) this.bookings.set(b.id, { ...bRow, itineraryId: null });
      }
    }
    this.rows.delete(id);
  }

  async findBookingsByIds(ids: string[], userId: string): Promise<ItineraryBookingRow[]> {
    return ids
      .map((id) => this.bookings.get(id))
      .filter((b): b is ItineraryBookingRow => b !== undefined && b.userId === userId);
  }
}

// ---------------------------------------------------------------------------
// Security event writer spy
// ---------------------------------------------------------------------------

function makeSecuritySpy(): SecurityEventWriter & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    async write(event) {
      events.push(event);
    },
  } as SecurityEventWriter & { events: unknown[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ItineraryService", () => {
  let repo: InMemoryItineraryRepo;
  let securitySpy: ReturnType<typeof makeSecuritySpy>;
  let svc: ItineraryService;

  beforeEach(() => {
    repo = new InMemoryItineraryRepo();
    securitySpy = makeSecuritySpy();
    svc = new ItineraryService(repo, securitySpy, { now: () => FIXED_NOW });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe("create", () => {
    it("AC1: rejects fewer than two bookingIds with VALIDATION_FAILED", async () => {
      repo.seedBooking(makeBookingRow(BK_1, USER_A, "USD", "100.00"));
      await expect(
        svc.create(USER_A, ACTOR_A, {
          name: "Trip",
          startDate: START,
          endDate: END,
          bookingIds: [BK_1],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", field: "bookingIds" });
    });

    it("AC4/AC5: rejects booking owned by another user with FORBIDDEN + security event", async () => {
      repo.seedBooking(makeBookingRow(BK_1, USER_A, "USD", "100.00"));
      repo.seedBooking(makeBookingRow(BK_2, USER_B, "USD", "200.00")); // owned by B

      await expect(
        svc.create(USER_A, ACTOR_A, {
          name: "Trip",
          startDate: START,
          endDate: END,
          bookingIds: [BK_1, BK_2],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const denied = securitySpy.events.filter(
        (e: unknown) => (e as { decision: string }).decision === "DENY",
      );
      expect(denied).toHaveLength(1);
    });

    it("rejects booking already attached to another itinerary with CONFLICT", async () => {
      repo.seedBooking(makeBookingRow(BK_1, USER_A, "USD", "100.00", "itn_other"));
      repo.seedBooking(makeBookingRow(BK_2, USER_A, "USD", "200.00"));

      await expect(
        svc.create(USER_A, ACTOR_A, {
          name: "Trip",
          startDate: START,
          endDate: END,
          bookingIds: [BK_1, BK_2],
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("AC9: rejects endDate before startDate with VALIDATION_FAILED", async () => {
      repo.seedBooking(makeBookingRow(BK_1, USER_A, "USD", "100.00"));
      repo.seedBooking(makeBookingRow(BK_2, USER_A, "USD", "200.00"));

      await expect(
        svc.create(USER_A, ACTOR_A, {
          name: "Trip",
          startDate: END,
          endDate: START, // wrong order
          bookingIds: [BK_1, BK_2],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", field: "endDate" });
    });

    it("creates itinerary and writes ALLOW security event", async () => {
      repo.seedBooking(makeBookingRow(BK_1, USER_A, "USD", "100.00"));
      repo.seedBooking(makeBookingRow(BK_2, USER_A, "USD", "200.00"));

      const result = await svc.create(USER_A, ACTOR_A, {
        name: "My Trip",
        startDate: START,
        endDate: END,
        bookingIds: [BK_1, BK_2],
      });

      expect(result.name).toBe("My Trip");
      expect(result.bookings).toHaveLength(2);
      const allow = securitySpy.events.find(
        (e: unknown) => (e as { decision: string }).decision === "ALLOW",
      );
      expect(allow).toBeDefined();
    });
  });

  // ── getById ────────────────────────────────────────────────────────────

  describe("getById", () => {
    it("AC3: returns 404 for a non-existent id", async () => {
      await expect(
        svc.getById("nonexistent", USER_A, ACTOR_A),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("AC3: returns 403 + security event for an itinerary owned by another user", async () => {
      repo.seed(makeItineraryRow({ userId: USER_B }));

      await expect(
        svc.getById(ITN_ID, USER_A, ACTOR_A),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const denied = securitySpy.events.filter(
        (e: unknown) => (e as { decision: string }).decision === "DENY",
      );
      expect(denied).toHaveLength(1);
    });

    it("returns the itinerary with bookings and per-currency totals", async () => {
      repo.seed(
        makeItineraryRow({
          bookings: [
            makeBookingRow(BK_1, USER_A, "USD", "200.00"),
            makeBookingRow(BK_2, USER_A, "USD", "150.00"),
          ],
        }),
      );

      const result = await svc.getById(ITN_ID, USER_A, ACTOR_A);

      expect(result.id).toBe(ITN_ID);
      expect(result.totals).toHaveLength(1);
      expect(result.totals[0]).toEqual({ currency: "USD", amount: "350.00" });
    });
  });

  // ── per-currency totals ────────────────────────────────────────────────

  describe("per-currency totals", () => {
    it("AC6: does not sum amounts across different currencies", async () => {
      repo.seed(
        makeItineraryRow({
          bookings: [
            makeBookingRow(BK_1, USER_A, "USD", "100.00"),
            makeBookingRow(BK_2, USER_A, "EUR", "80.00"),
            makeBookingRow(BK_3, USER_A, "GBP", "60.00"),
          ],
        }),
      );

      const result = await svc.getById(ITN_ID, USER_A, ACTOR_A);

      expect(result.totals).toHaveLength(3);
      // Sorted by currency code
      expect(result.totals[0]).toEqual({ currency: "EUR", amount: "80.00" });
      expect(result.totals[1]).toEqual({ currency: "GBP", amount: "60.00" });
      expect(result.totals[2]).toEqual({ currency: "USD", amount: "100.00" });
    });

    it("sums same-currency amounts with integer precision (no floats)", async () => {
      repo.seed(
        makeItineraryRow({
          bookings: [
            makeBookingRow(BK_1, USER_A, "USD", "0.10"),
            makeBookingRow(BK_2, USER_A, "USD", "0.20"),
          ],
        }),
      );

      const result = await svc.getById(ITN_ID, USER_A, ACTOR_A);

      // 10 cents + 20 cents = 30 cents — must be "0.30", not a float artifact
      expect(result.totals[0]).toEqual({ currency: "USD", amount: "0.30" });
    });

    it("includes cancelled/expired bookings in totals (state does not hide)", async () => {
      repo.seed(
        makeItineraryRow({
          bookings: [
            makeBookingRow(BK_1, USER_A, "USD", "500.00"),
            { ...makeBookingRow(BK_2, USER_A, "USD", "300.00"), status: "CANCELLED" },
          ],
        }),
      );

      const result = await svc.getById(ITN_ID, USER_A, ACTOR_A);

      expect(result.bookings).toHaveLength(2);
      expect(result.totals[0]).toEqual({ currency: "USD", amount: "800.00" });
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe("update", () => {
    it("AC7: rejects detach that would leave fewer than 2 members", async () => {
      repo.seed(makeItineraryRow());

      await expect(
        svc.update(ITN_ID, USER_A, ACTOR_A, { removeBookingIds: [BK_1] }),
      ).rejects.toMatchObject({ code: "CONFLICT", field: "removeBookingIds" });
    });

    it("AC7: rejects attach of booking already in another itinerary with CONFLICT", async () => {
      repo.seed(makeItineraryRow());
      repo.seedBooking(makeBookingRow(BK_3, USER_A, "USD", "100.00", "itn_other"));

      await expect(
        svc.update(ITN_ID, USER_A, ACTOR_A, { addBookingIds: [BK_3] }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("AC3: returns 403 + audit when user B patches user A itinerary", async () => {
      repo.seed(makeItineraryRow({ userId: USER_A }));

      await expect(
        svc.update(ITN_ID, USER_A, ACTOR_B, { name: "Hijacked" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const denied = securitySpy.events.filter(
        (e: unknown) => (e as { decision: string }).decision === "DENY",
      );
      expect(denied).toHaveLength(1);
    });

    it("renames itinerary and writes ALLOW audit", async () => {
      repo.seed(makeItineraryRow());

      const result = await svc.update(ITN_ID, USER_A, ACTOR_A, { name: "Renamed" });

      expect(result.name).toBe("Renamed");
      const allow = securitySpy.events.find(
        (e: unknown) => (e as { operation: string }).operation === "UPDATE" &&
          (e as { decision: string }).decision === "ALLOW",
      );
      expect(allow).toBeDefined();
    });

    it("returns CONFLICT when optimistic-version check fails", async () => {
      repo.seed(makeItineraryRow({ version: 5 }));

      // expectedVersion will be 5 but we corrupt it internally:
      // Simulate a concurrent update by directly bumping version in the repo
      // In real code, updateMany returns count=0 → service returns null → throws conflict
      // We test by patching the repo to simulate version mismatch
      const originalUpdate = repo.update.bind(repo);
      repo.update = vi.fn().mockResolvedValue(null);

      await expect(
        svc.update(ITN_ID, USER_A, ACTOR_A, { name: "Race" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      repo.update = originalUpdate;
    });
  });

  // ── delete ────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("AC8: deletes itinerary and detaches bookings without deleting them", async () => {
      const bk1 = makeBookingRow(BK_1, USER_A, "USD", "100.00", ITN_ID);
      const bk2 = makeBookingRow(BK_2, USER_A, "USD", "200.00", ITN_ID);
      repo.seed(makeItineraryRow({ bookings: [bk1, bk2] }));
      repo.seedBooking(bk1);
      repo.seedBooking(bk2);

      await svc.delete(ITN_ID, USER_A, ACTOR_A);

      expect(repo.deleteCallCount).toBe(1);
      // Bookings still exist
      const b1 = await repo.findBookingsByIds([BK_1], USER_A);
      expect(b1).toHaveLength(1);
    });

    it("AC8: writes ALLOW audit event after delete", async () => {
      repo.seed(makeItineraryRow());

      await svc.delete(ITN_ID, USER_A, ACTOR_A);

      const deleteEvent = securitySpy.events.find(
        (e: unknown) =>
          (e as { operation: string }).operation === "DELETE" &&
          (e as { decision: string }).decision === "ALLOW",
      );
      expect(deleteEvent).toBeDefined();
    });

    it("returns 404 for non-existent itinerary", async () => {
      await expect(
        svc.delete("nonexistent", USER_A, ACTOR_A),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns 403 + security event when deleting another user's itinerary", async () => {
      repo.seed(makeItineraryRow({ userId: USER_B }));

      await expect(
        svc.delete(ITN_ID, USER_A, ACTOR_A),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const denied = securitySpy.events.filter(
        (e: unknown) => (e as { decision: string }).decision === "DENY",
      );
      expect(denied).toHaveLength(1);
    });
  });

  // ── listByUser ─────────────────────────────────────────────────────────

  describe("listByUser", () => {
    it("returns only itineraries owned by the requesting user", async () => {
      repo.seed(makeItineraryRow({ id: "itn_a", userId: USER_A }));
      repo.seed(makeItineraryRow({ id: "itn_b", userId: USER_B }));

      const result = await svc.listByUser(USER_A, ACTOR_A);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toBe("itn_a");
      expect(result.total).toBe(1);
    });
  });
});
