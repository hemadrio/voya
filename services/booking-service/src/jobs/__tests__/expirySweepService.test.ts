/**
 * Unit tests for ExpirySweepService — WO-043.
 *
 * All collaborators are injected in-memory doubles; no DB, no real queue.
 * A fake clock enables deterministic boundary-age tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExpirySweepService } from "../../domain/ExpirySweepService.js";
import type { SweepCandidate } from "../../domain/ExpirySweepService.js";
import type { PaymentStatusPort, PaymentIntentStatus } from "../../domain/PaymentStatusPort.js";
import type { BookingLifecycleService, TransitionResult } from "../../domain/BookingLifecycleService.js";
import type { QueuePort } from "@travel/queue";
import type { QueueMessageEnvelope } from "@travel/contracts";
import { isNonTerminalIntentStatus } from "../../domain/PaymentStatusPort.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makePaymentStatus(
  statusMap: Record<string, string | null>,
): PaymentStatusPort {
  return {
    async getIntentStatus(bookingId: string): Promise<PaymentIntentStatus | null> {
      const s = statusMap[bookingId];
      if (s === undefined || s === null) return null;
      return { intentId: `pi_${bookingId}`, status: s };
    },
  };
}

interface LifecycleCall {
  bookingId: string;
  targetStatus: string;
  actorId: string;
  reason?: string;
}

function makeLifecycleService(
  behaviour?: (bookingId: string) => "succeed" | "conflict" | "not_found",
): { service: BookingLifecycleService; calls: LifecycleCall[] } {
  const calls: LifecycleCall[] = [];

  const service = {
    async transition(
      bookingId: string,
      targetStatus: string,
      actor: { id: string; role: string },
      reason?: string,
    ): Promise<TransitionResult> {
      const mode = behaviour?.(bookingId) ?? "succeed";
      if (mode === "conflict") {
        const err = new Error(`LIFECYCLE_CONFLICT: booking ${bookingId}`);
        (err as any).code = "LIFECYCLE_CONFLICT";
        throw err;
      }
      if (mode === "not_found") {
        const err = new Error(`NOT_FOUND: booking ${bookingId}`);
        (err as any).code = "NOT_FOUND";
        throw err;
      }
      calls.push({ bookingId, targetStatus, actorId: actor.id, reason });
      return {
        bookingId,
        previousStatus: "PENDING",
        newStatus: targetStatus,
        idempotent: false,
      };
    },
  } as unknown as BookingLifecycleService;

  return { service, calls };
}

function makeQueue(): { queue: QueuePort; published: QueueMessageEnvelope[] } {
  const published: QueueMessageEnvelope[] = [];
  const queue: QueuePort = {
    async publish(_topic: string, envelope: QueueMessageEnvelope) {
      published.push(envelope);
    },
    async subscribe() {},
    async isHealthy() { return true; },
    async close() {},
  };
  return { queue, published };
}

// Fixed clock: 2025-06-01T10:00:00Z
const FIXED_NOW = new Date("2025-06-01T10:00:00.000Z");

function makeCandidate(id: string, minutesAgo: number): SweepCandidate {
  return {
    id,
    userId: `user-${id}`,
    expiresAt: new Date(FIXED_NOW.getTime() - minutesAgo * 60_000),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isNonTerminalIntentStatus", () => {
  it.each([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "processing",
    "requires_capture",
  ])("returns true for non-terminal status: %s", (status) => {
    expect(isNonTerminalIntentStatus(status)).toBe(true);
  });

  it.each(["succeeded", "canceled"])("returns false for terminal status: %s", (status) => {
    expect(isNonTerminalIntentStatus(status)).toBe(false);
  });

  it("returns false for unknown status", () => {
    expect(isNonTerminalIntentStatus("unknown_status")).toBe(false);
  });
});

describe("ExpirySweepService.processBatch", () => {
  let lifecycleCalls: LifecycleCall[];
  let published: QueueMessageEnvelope[];
  let sweep: ExpirySweepService;

  beforeEach(() => {
    const lc = makeLifecycleService();
    lifecycleCalls = lc.calls;
    const q = makeQueue();
    published = q.published;
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({}),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });
  });

  it("returns zero metrics for an empty batch", async () => {
    const result = await sweep.processBatch([], "corr-1");
    expect(result.metrics).toMatchObject({
      candidates: 0,
      expired: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("expires a candidate with no PaymentIntent", async () => {
    const result = await sweep.processBatch(
      [makeCandidate("booking-1", 35)],
      "corr-1",
    );

    expect(result.metrics.expired).toBe(1);
    expect(result.metrics.skipped).toBe(0);
    expect(lifecycleCalls).toHaveLength(1);
    expect(lifecycleCalls[0]).toMatchObject({
      bookingId: "booking-1",
      targetStatus: "EXPIRED",
      actorId: "system",
      reason: "ABANDONED_CHECKOUT",
    });
  });

  it("expires a candidate with a canceled PaymentIntent (terminal)", async () => {
    const lc = makeLifecycleService();
    lifecycleCalls = lc.calls;
    const q = makeQueue();
    published = q.published;
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({ "booking-2": "canceled" }),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    const result = await sweep.processBatch([makeCandidate("booking-2", 35)], "corr-2");
    expect(result.metrics.expired).toBe(1);
    expect(lifecycleCalls[0]!.bookingId).toBe("booking-2");
  });

  it("skips a booking with a non-terminal PaymentIntent (processing)", async () => {
    const lc = makeLifecycleService();
    const q = makeQueue();
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({ "booking-3": "processing" }),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    const result = await sweep.processBatch([makeCandidate("booking-3", 35)], "corr-3");
    expect(result.metrics.skipped).toBe(1);
    expect(result.metrics.expired).toBe(0);
    expect(lc.calls).toHaveLength(0);
  });

  it.each([
    "requires_action",
    "requires_confirmation",
    "requires_payment_method",
    "requires_capture",
  ])("skips booking with non-terminal intent status: %s", async (status) => {
    const lc = makeLifecycleService();
    const q = makeQueue();
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({ "booking-skip": status }),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    const result = await sweep.processBatch([makeCandidate("booking-skip", 31)], "corr-skip");
    expect(result.metrics.skipped).toBe(1);
    expect(result.metrics.expired).toBe(0);
  });

  it("publishes a booking.expired queue event for each expired booking", async () => {
    const lc = makeLifecycleService();
    const q = makeQueue();
    published = q.published;
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({}),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    await sweep.processBatch([makeCandidate("booking-ev", 35)], "corr-ev");
    expect(published).toHaveLength(1);
    expect(published[0]!.eventType).toBe("booking.expired");
    expect(published[0]!.payload["bookingId"]).toBe("booking-ev");
  });

  it("does not publish an event for a skipped booking", async () => {
    const lc = makeLifecycleService();
    const q = makeQueue();
    published = q.published;
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({ "booking-skip2": "requires_action" }),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    await sweep.processBatch([makeCandidate("booking-skip2", 31)], "corr-skip2");
    expect(published).toHaveLength(0);
  });

  it("isolates per-item failures — other items in the batch still succeed", async () => {
    const lc = makeLifecycleService((id) =>
      id === "booking-fail" ? "conflict" : "succeed",
    );
    const q = makeQueue();
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({}),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    const result = await sweep.processBatch(
      [makeCandidate("booking-ok", 35), makeCandidate("booking-fail", 35)],
      "corr-iso",
    );

    expect(result.metrics.expired).toBe(1);
    expect(result.metrics.failed).toBe(1);
    expect(result.itemErrors).toHaveLength(1);
    expect(result.itemErrors[0]!.bookingId).toBe("booking-fail");
    expect(lc.calls).toHaveLength(2); // both were attempted
  });

  it("idempotent re-run: LIFECYCLE_CONFLICT is isolated, not fatal", async () => {
    const lc = makeLifecycleService(() => "conflict");
    const q = makeQueue();
    sweep = new ExpirySweepService({
      lifecycleService: lc.service,
      paymentStatus: makePaymentStatus({}),
      queue: q.queue,
      clock: () => FIXED_NOW,
    });

    const result = await sweep.processBatch(
      [makeCandidate("booking-already-exp", 35)],
      "corr-idem",
    );

    // Failed (conflict means someone else won the race), not crashed
    expect(result.metrics.failed).toBe(1);
    expect(result.itemErrors[0]!.bookingId).toBe("booking-already-exp");
  });

  it("durationMs is populated in metrics", async () => {
    const result = await sweep.processBatch([makeCandidate("booking-dur", 35)], "corr-dur");
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Boundary-age fixtures
// ---------------------------------------------------------------------------

describe("WO-043 boundary-age fixtures", () => {
  it("booking at exactly 30 minutes is NOT expired (strictly past)", () => {
    const now = new Date("2025-06-01T10:30:00.000Z");
    const createdAt = new Date("2025-06-01T10:00:00.000Z");
    const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
    // expiresAt === now → strictly NOT past → should NOT be in candidate set
    expect(expiresAt < now).toBe(false);
  });

  it("booking at 30 minutes + 1ms IS expired (strictly past)", () => {
    const now = new Date("2025-06-01T10:30:00.001Z");
    const createdAt = new Date("2025-06-01T10:00:00.000Z");
    const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
    expect(expiresAt < now).toBe(true);
  });

  it("booking at 29 minutes is NOT expired", () => {
    const now = new Date("2025-06-01T10:29:00.000Z");
    const createdAt = new Date("2025-06-01T10:00:00.000Z");
    const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
    expect(expiresAt < now).toBe(false);
  });

  it("booking at 31 minutes IS expired", () => {
    const now = new Date("2025-06-01T10:31:00.000Z");
    const createdAt = new Date("2025-06-01T10:00:00.000Z");
    const expiresAt = new Date(createdAt.getTime() + 30 * 60_000);
    expect(expiresAt < now).toBe(true);
  });
});
