/**
 * Characterization tests: CheckoutSaga commit-or-compensate behaviour.
 *
 * Covers:
 *   - Happy path: all three legs commit, outcome is success
 *   - First leg failure: no compensation needed (nothing committed)
 *   - Second leg failure: first leg compensated (reverse order)
 *   - Third leg failure: first two legs compensated in reverse order
 *   - Compensation ordering is always reverse-commit order
 *   - Charged legs produce RefundInstruction in compensation result
 *   - Non-charged legs produce no RefundInstruction
 *   - No confirmed booking until every leg resolves
 */

import { describe, it, expect } from "vitest";
import { runCheckoutSaga, type SagaLeg, type SagaLegResult, type CompensationResult } from "../CheckoutSaga.js";

// ---------------------------------------------------------------------------
// Fake leg builders
// ---------------------------------------------------------------------------

function makeSuccessLeg(
  id: string,
  opts: { charged?: boolean; externalRef?: string; amount?: string } = {},
): SagaLeg & { compensateCalls: string[] } {
  const compensateCalls: string[] = [];
  return {
    id,
    compensateCalls,
    async execute(): Promise<SagaLegResult> {
      return {
        legId: id,
        charged: opts.charged ?? false,
        externalReference: opts.externalRef,
        chargedAmount: opts.amount,
        currency: "USD",
      };
    },
    async compensate(result: SagaLegResult): Promise<CompensationResult> {
      compensateCalls.push(id);
      const refundRequired = result.charged && !!result.externalReference;
      return {
        legId: id,
        refundRequired,
        refundInstruction: refundRequired
          ? {
              legId: id,
              externalReference: result.externalReference!,
              chargedAmount: result.chargedAmount ?? "0",
              currency: result.currency ?? "USD",
              reason: "checkout saga compensation",
            }
          : undefined,
      };
    },
  };
}

function makeFailingLeg(id: string, error: Error): SagaLeg {
  return {
    id,
    async execute(): Promise<SagaLegResult> {
      throw error;
    },
    async compensate(_result: SagaLegResult): Promise<CompensationResult> {
      return { legId: id, refundRequired: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("CheckoutSaga — happy path", () => {
  it("returns success when all three legs commit", async () => {
    const leg1 = makeSuccessLeg("flight", { charged: true, externalRef: "PNR-001", amount: "412.50" });
    const leg2 = makeSuccessLeg("hotel", { charged: true, externalRef: "HTL-001", amount: "210.00" });
    const leg3 = makeSuccessLeg("car", { charged: true, externalRef: "CAR-001", amount: "89.00" });

    const outcome = await runCheckoutSaga([leg1, leg2, leg3]);

    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.results).toHaveLength(3);
      expect(outcome.results.map((r) => r.legId)).toEqual(["flight", "hotel", "car"]);
    }
  });

  it("does not run compensation on success", async () => {
    const leg1 = makeSuccessLeg("flight", { charged: true, externalRef: "PNR-001" });
    const leg2 = makeSuccessLeg("hotel", { charged: false });

    await runCheckoutSaga([leg1, leg2]);

    expect(leg1.compensateCalls).toHaveLength(0);
    expect(leg2.compensateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure compensation ordering
// ---------------------------------------------------------------------------

describe("CheckoutSaga — compensation on failure", () => {
  it("runs no compensation when the first leg fails (nothing committed)", async () => {
    const leg1 = makeFailingLeg("flight", new Error("supplier rejected"));
    const leg2 = makeSuccessLeg("hotel");
    const leg3 = makeSuccessLeg("car");

    const outcome = await runCheckoutSaga([leg1, leg2, leg3]);

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.failedLegId).toBe("flight");
      expect(outcome.refundInstructions).toHaveLength(0);
    }
  });

  it("compensates the first leg when the second leg fails", async () => {
    const compensated: string[] = [];

    const leg1: SagaLeg = {
      id: "flight",
      async execute(): Promise<SagaLegResult> {
        return { legId: "flight", charged: true, externalReference: "PNR-001", chargedAmount: "412.50", currency: "USD" };
      },
      async compensate(result): Promise<CompensationResult> {
        compensated.push("flight");
        return {
          legId: "flight",
          refundRequired: true,
          refundInstruction: {
            legId: "flight",
            externalReference: result.externalReference!,
            chargedAmount: result.chargedAmount!,
            currency: result.currency!,
            reason: "checkout saga compensation",
          },
        };
      },
    };

    const leg2 = makeFailingLeg("hotel", new Error("hotel unavailable"));
    const leg3 = makeSuccessLeg("car");

    const outcome = await runCheckoutSaga([leg1, leg2, leg3]);

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.failedLegId).toBe("hotel");
      expect(compensated).toEqual(["flight"]); // only leg1 was committed
      expect(outcome.refundInstructions).toHaveLength(1);
      expect(outcome.refundInstructions[0]!.legId).toBe("flight");
      expect(outcome.refundInstructions[0]!.externalReference).toBe("PNR-001");
    }
  });

  it("compensates all committed legs in reverse order when third leg fails", async () => {
    const compensated: string[] = [];

    function makeLegWithTracking(id: string, ref: string): SagaLeg {
      return {
        id,
        async execute(): Promise<SagaLegResult> {
          return { legId: id, charged: true, externalReference: ref, chargedAmount: "100.00", currency: "USD" };
        },
        async compensate(_result): Promise<CompensationResult> {
          compensated.push(id);
          return { legId: id, refundRequired: true, refundInstruction: {
            legId: id, externalReference: ref, chargedAmount: "100.00", currency: "USD",
            reason: "checkout saga compensation",
          }};
        },
      };
    }

    const leg1 = makeLegWithTracking("flight", "PNR-001");
    const leg2 = makeLegWithTracking("hotel", "HTL-001");
    const leg3 = makeFailingLeg("car", new Error("car unavailable"));

    const outcome = await runCheckoutSaga([leg1, leg2, leg3]);

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.failedLegId).toBe("car");
      // Compensation must be in reverse commit order: hotel then flight
      expect(compensated).toEqual(["hotel", "flight"]);
      expect(outcome.refundInstructions).toHaveLength(2);
      // Refund instructions are returned in compensation order (hotel, flight)
      expect(outcome.refundInstructions[0]!.legId).toBe("hotel");
      expect(outcome.refundInstructions[1]!.legId).toBe("flight");
    }
  });

  it("includes refund instructions only for charged legs", async () => {
    const leg1: SagaLeg = {
      id: "flight",
      async execute(): Promise<SagaLegResult> {
        return { legId: "flight", charged: true, externalReference: "PNR-001", chargedAmount: "412.50", currency: "USD" };
      },
      async compensate(result): Promise<CompensationResult> {
        return {
          legId: "flight", refundRequired: true,
          refundInstruction: {
            legId: "flight", externalReference: result.externalReference!,
            chargedAmount: result.chargedAmount!, currency: "USD",
            reason: "checkout saga compensation",
          },
        };
      },
    };

    const leg2: SagaLeg = {
      id: "addon",
      async execute(): Promise<SagaLegResult> {
        return { legId: "addon", charged: false };
      },
      async compensate(_result): Promise<CompensationResult> {
        return { legId: "addon", refundRequired: false };
      },
    };

    const leg3 = makeFailingLeg("car", new Error("car failure"));

    const outcome = await runCheckoutSaga([leg1, leg2, leg3]);
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      // Only leg1 (charged) has a refund instruction; leg2 (not charged) has none
      const withRefund = outcome.refundInstructions.filter((r) => r.legId === "flight");
      const withoutRefund = outcome.refundInstructions.filter((r) => r.legId === "addon");
      expect(withRefund).toHaveLength(1);
      expect(withoutRefund).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// No confirmation until all legs resolve
// ---------------------------------------------------------------------------

describe("CheckoutSaga — no partial confirmation", () => {
  it("returns success only after every leg executes without error", async () => {
    let leg2Started = false;
    let sagaCompleted = false;

    const leg1 = makeSuccessLeg("flight", { charged: true, externalRef: "PNR-001" });
    const leg2: SagaLeg = {
      id: "hotel",
      async execute(): Promise<SagaLegResult> {
        leg2Started = true;
        // Simulate slow supplier
        await Promise.resolve();
        return { legId: "hotel", charged: true, externalReference: "HTL-001", chargedAmount: "200.00", currency: "USD" };
      },
      async compensate(_result): Promise<CompensationResult> {
        return { legId: "hotel", refundRequired: false };
      },
    };

    const sagaPromise = runCheckoutSaga([leg1, leg2]).then((outcome) => {
      sagaCompleted = true;
      return outcome;
    });

    // Before await — saga is in-flight
    expect(sagaCompleted).toBe(false);

    const outcome = await sagaPromise;
    expect(sagaCompleted).toBe(true);
    expect(leg2Started).toBe(true);
    expect(outcome.success).toBe(true);
  });
});
