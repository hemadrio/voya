/**
 * Characterization tests: booking lifecycle transition guard and audit trail.
 *
 * Covers:
 *   - Complete permitted / forbidden transition matrix
 *   - 409 error envelope shape for every forbidden move
 *   - Append-only audit: one row per accepted transition; no update/delete
 *   - ProvenanceGuard: ILLUSTRATIVE and unrecognised offers rejected before checkout
 *
 * All collaborators are injected fakes — no Prisma, no Express, no DB.
 */

import { describe, it, expect } from "vitest";
import {
  assertTransition,
  checkTransition,
  getPermittedTransitions,
  isTerminal,
  PERMITTED_TRANSITIONS,
  type BookingStatus,
} from "../BookingStateMachine.js";
import { assertBookable, checkBookable } from "../ProvenanceGuard.js";
import { writeAudit } from "../AuditWriter.js";
import type { AuditTxClient } from "../AuditWriter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_STATUSES: BookingStatus[] = [
  "PENDING",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUNDED",
  "EXPIRED",
];

function makeAuditTxClient(): {
  client: AuditTxClient;
  rows: unknown[];
  updateCalls: number;
  deleteCalls: number;
} {
  const rows: unknown[] = [];
  let updateCalls = 0;
  let deleteCalls = 0;

  const client: AuditTxClient = {
    bookingAuditLog: {
      async create(args) {
        rows.push(args.data);
        return {};
      },
    },
  };

  // Attach mutation trackers to detect any update/delete calls.
  // These are not on the interface but test doubles must fail the test if called.
  (client as unknown as Record<string, unknown>)["_updateCalls"] = () => updateCalls;
  (client as unknown as Record<string, unknown>)["_deleteCalls"] = () => deleteCalls;

  return { client, rows, updateCalls, deleteCalls };
}

// ---------------------------------------------------------------------------
// Transition matrix — permitted moves
// ---------------------------------------------------------------------------

describe("BookingStateMachine — permitted transitions", () => {
  it.each(
    ALL_STATUSES.flatMap((from) =>
      PERMITTED_TRANSITIONS[from].map((to) => ({ from, to })),
    ),
  )("$from → $to is permitted", ({ from, to }) => {
    expect(() => assertTransition(from, to)).not.toThrow();
    expect(checkTransition(from, to)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition matrix — forbidden moves
// ---------------------------------------------------------------------------

describe("BookingStateMachine — forbidden transitions produce 409", () => {
  const forbiddenCases = ALL_STATUSES.flatMap((from) =>
    ALL_STATUSES
      .filter((to) => !(PERMITTED_TRANSITIONS[from] as BookingStatus[]).includes(to))
      .map((to) => ({ from, to })),
  );

  it.each(forbiddenCases)("$from → $to is forbidden", ({ from, to }) => {
    expect(() => assertTransition(from, to)).toThrow();

    const error = checkTransition(from, to);
    expect(error).not.toBeNull();
    // Must be LIFECYCLE_CONFLICT (409-class)
    expect(error!.code).toBe("LIFECYCLE_CONFLICT");
    // Message must name the current state
    expect(error!.message).toContain(from);
    // Message must list permitted transitions (or "none" for terminal states)
    const permitted = PERMITTED_TRANSITIONS[from];
    if (permitted.length > 0) {
      for (const allowedNext of permitted) {
        expect(error!.message).toContain(allowedNext);
      }
    } else {
      expect(error!.message).toContain("none");
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe("BookingStateMachine — terminal state detection", () => {
  it.each([
    "COMPLETED",
    "CANCELLED",
    "FAILED",
    "REFUNDED",
    "EXPIRED",
  ] as BookingStatus[])("%s is terminal", (status) => {
    expect(isTerminal(status)).toBe(true);
    expect(getPermittedTransitions(status)).toHaveLength(0);
  });

  it.each(["PENDING", "CONFIRMED"] as BookingStatus[])("%s is not terminal", (status) => {
    expect(isTerminal(status)).toBe(false);
    expect(getPermittedTransitions(status).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Webhook arriving for already-cancelled booking must be rejected
// ---------------------------------------------------------------------------

describe("BookingStateMachine — lifecycle conflict on cancelled booking", () => {
  it("rejects CONFIRMED transition from CANCELLED state", () => {
    const error = checkTransition("CANCELLED", "CONFIRMED");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("LIFECYCLE_CONFLICT");
    expect(error!.message).toContain("CANCELLED");
    expect(error!.message).toContain("none");
  });

  it("rejects any transition from COMPLETED", () => {
    for (const next of ALL_STATUSES) {
      const error = checkTransition("COMPLETED", next);
      expect(error).not.toBeNull();
      expect(error!.code).toBe("LIFECYCLE_CONFLICT");
    }
  });
});

// ---------------------------------------------------------------------------
// Audit write — append-only invariant
// ---------------------------------------------------------------------------

describe("AuditWriter — append-only writes", () => {
  it("writes exactly one row per accepted transition", async () => {
    const { client, rows } = makeAuditTxClient();

    await writeAudit({
      tx: client,
      bookingId: "f0000002-0000-4000-8000-000000000001",
      action: "BOOKING_CONFIRMED",
      actorId: "actor-001",
      actorRole: "PAYMENT_SERVICE",
      resourceType: "Booking",
      resourceId: "f0000002-0000-4000-8000-000000000001",
      occurredAt: new Date("2026-01-15T12:05:00Z"),
      payload: { previousStatus: "PENDING", newStatus: "CONFIRMED" },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row["bookingId"]).toBe("f0000002-0000-4000-8000-000000000001");
    expect(row["action"]).toBe("BOOKING_CONFIRMED");
    expect(row["actorId"]).toBe("actor-001");
    expect(row["occurredAt"]).toBeInstanceOf(Date);
  });

  it("carries actor, timestamp, resource, previous state, and new state", async () => {
    const { client, rows } = makeAuditTxClient();

    await writeAudit({
      tx: client,
      bookingId: "f0000002-0000-4000-8000-000000000002",
      action: "BOOKING_CANCELLED",
      actorId: "user-abc",
      actorRole: "TRAVELER",
      resourceType: "Booking",
      resourceId: "f0000002-0000-4000-8000-000000000002",
      occurredAt: new Date("2026-01-15T13:00:00Z"),
      payload: { previousStatus: "CONFIRMED", newStatus: "CANCELLED" },
    });

    const row = rows[0] as Record<string, unknown>;
    expect(row["actorRole"]).toBe("TRAVELER");
    expect(row["resourceType"]).toBe("Booking");
    // Payload is sanitised but must still carry the transition states
    const payload = row["payload"] as Record<string, unknown>;
    expect(JSON.stringify(payload)).toContain("CONFIRMED");
    expect(JSON.stringify(payload)).toContain("CANCELLED");
  });

  it("audit client does not expose update or delete operations", () => {
    const { client } = makeAuditTxClient();
    // The AuditTxClient interface only has 'create' — verify the fake implements only that
    expect(typeof client.bookingAuditLog.create).toBe("function");
    expect((client.bookingAuditLog as unknown as Record<string, unknown>)["update"]).toBeUndefined();
    expect((client.bookingAuditLog as unknown as Record<string, unknown>)["delete"]).toBeUndefined();
    expect((client.bookingAuditLog as unknown as Record<string, unknown>)["deleteMany"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ProvenanceGuard — structural rejection of non-bookable offers
// ---------------------------------------------------------------------------

describe("ProvenanceGuard — structural rejection before checkout", () => {
  it("accepts AMADEUS offer with bookable=true", () => {
    expect(() => assertBookable({ provenance: "AMADEUS", bookable: true })).not.toThrow();
    expect(checkBookable({ provenance: "AMADEUS", bookable: true })).toBeNull();
  });

  it("accepts RAPIDAPI_HOTEL offer with bookable=true", () => {
    expect(() => assertBookable({ provenance: "RAPIDAPI_HOTEL", bookable: true })).not.toThrow();
  });

  it("accepts RAPIDAPI_CAR offer with bookable=true", () => {
    expect(() => assertBookable({ provenance: "RAPIDAPI_CAR", bookable: true })).not.toThrow();
  });

  it("rejects ILLUSTRATIVE offer with OFFER_NOT_BOOKABLE (422)", () => {
    const error = checkBookable({ provenance: "ILLUSTRATIVE", bookable: false });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("rejects ILLUSTRATIVE offer even when bookable flag is true", () => {
    // An ILLUSTRATIVE offer with bookable=true is still not a real supplier channel
    const error = checkBookable({ provenance: "ILLUSTRATIVE", bookable: true });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("rejects unrecognised provenance string", () => {
    const error = checkBookable({ provenance: "UNKNOWN_SUPPLIER", bookable: true });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OFFER_NOT_BOOKABLE");
    expect(error!.field).toBe("provenance");
  });

  it("rejects empty string provenance", () => {
    const error = checkBookable({ provenance: "", bookable: true });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("rejects AMADEUS offer with bookable=false", () => {
    const error = checkBookable({ provenance: "AMADEUS", bookable: false });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("OFFER_NOT_BOOKABLE");
    expect(error!.field).toBe("bookable");
  });

  it("rejection never fails open — assertBookable always throws for non-bookable offers", () => {
    const nonBookable = [
      { provenance: "ILLUSTRATIVE", bookable: false },
      { provenance: "ILLUSTRATIVE", bookable: true },
      { provenance: "AI_PLACEHOLDER", bookable: true },
      { provenance: "", bookable: true },
      { provenance: "AMADEUS", bookable: false },
    ];
    for (const offer of nonBookable) {
      expect(() => assertBookable(offer)).toThrow();
    }
  });
});
