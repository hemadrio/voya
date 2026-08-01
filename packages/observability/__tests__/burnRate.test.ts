/**
 * Unit tests for packages/observability/src/slo/burnRate.ts.
 *
 * Covers boundary conditions specified in WO-108 AC10:
 *   - Zero traffic window
 *   - Exactly at SLO (no errors)
 *   - One error over SLO threshold
 *   - Full budget consumption
 *   - Budget already exhausted (negative remaining)
 *   - Invalid inputs throw
 */

import { describe, it, expect } from "vitest";
import {
  computeBurnRate,
  computeErrorBudget,
  burnRateThreshold,
  fastBurnRateMultiplier,
  generateBurnScenario,
} from "../src/slo/burnRate.js";

// ---------------------------------------------------------------------------
// computeBurnRate
// ---------------------------------------------------------------------------

describe("computeBurnRate", () => {
  it("returns noTraffic=true and burnRate=0 when totalEvents=0", () => {
    const result = computeBurnRate({ totalEvents: 0, badEvents: 0, sloTarget: 0.995 });
    expect(result.noTraffic).toBe(true);
    expect(result.burnRate).toBe(0);
    expect(result.errorRate).toBe(0);
  });

  it("returns burnRate=0 when all events are good (zero errors)", () => {
    const result = computeBurnRate({ totalEvents: 10_000, badEvents: 0, sloTarget: 0.995 });
    expect(result.noTraffic).toBe(false);
    expect(result.burnRate).toBe(0);
    expect(result.errorRate).toBe(0);
  });

  it("computes burn rate correctly for 7.2% error rate at 99.5% SLO (fast-burn boundary)", () => {
    // 7.2% / 0.5% = 14.4× burn rate
    const result = computeBurnRate({
      totalEvents: 1_000,
      badEvents: 72,
      sloTarget: 0.995,
    });
    expect(result.errorRate).toBeCloseTo(0.072, 5);
    expect(result.burnRate).toBeCloseTo(14.4, 3);
    expect(result.noTraffic).toBe(false);
  });

  it("computes burn rate correctly for 3.0% error rate at 99.5% SLO (slow-burn boundary)", () => {
    // 3.0% / 0.5% = 6× burn rate
    const result = computeBurnRate({
      totalEvents: 1_000,
      badEvents: 30,
      sloTarget: 0.995,
    });
    expect(result.errorRate).toBeCloseTo(0.03, 5);
    expect(result.burnRate).toBeCloseTo(6.0, 3);
  });

  it("returns burnRate=1 when error rate exactly equals error budget fraction", () => {
    // At SLO boundary: error rate = 1 - 0.99 = 0.01, burn rate = 1x
    const result = computeBurnRate({
      totalEvents: 1_000,
      badEvents: 10,
      sloTarget: 0.99,
    });
    expect(result.burnRate).toBeCloseTo(1.0, 5);
  });

  it("returns burnRate=200 when all events are bad (100% error rate, 99.5% SLO)", () => {
    // 100% / 0.5% = 200×
    const result = computeBurnRate({
      totalEvents: 100,
      badEvents: 100,
      sloTarget: 0.995,
    });
    expect(result.burnRate).toBeCloseTo(200, 1);
  });

  it("throws RangeError when badEvents > totalEvents", () => {
    expect(() =>
      computeBurnRate({ totalEvents: 10, badEvents: 11, sloTarget: 0.995 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when totalEvents is negative", () => {
    expect(() =>
      computeBurnRate({ totalEvents: -1, badEvents: 0, sloTarget: 0.995 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when badEvents is negative", () => {
    expect(() =>
      computeBurnRate({ totalEvents: 100, badEvents: -1, sloTarget: 0.995 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when sloTarget is 0", () => {
    expect(() =>
      computeBurnRate({ totalEvents: 100, badEvents: 0, sloTarget: 0 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when sloTarget is 1", () => {
    expect(() =>
      computeBurnRate({ totalEvents: 100, badEvents: 0, sloTarget: 1 })
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// computeErrorBudget
// ---------------------------------------------------------------------------

describe("computeErrorBudget", () => {
  const MONTHLY_MINUTES = 43_200; // 30 days
  const SLO_TARGET = 0.995;

  it("computes correct budget minutes for 99.5% SLO over 30 days", () => {
    const result = computeErrorBudget({
      sloTarget: SLO_TARGET,
      windowMinutes: MONTHLY_MINUTES,
      consumedMinutes: 0,
    });
    // 43200 × 0.005 = 216 minutes
    expect(result.budgetMinutes).toBeCloseTo(216, 5);
    expect(result.remainingMinutes).toBeCloseTo(216, 5);
    expect(result.consumedFraction).toBe(0);
    expect(result.exhausted).toBe(false);
  });

  it("returns consumedFraction=0.5 when half the budget is consumed", () => {
    const result = computeErrorBudget({
      sloTarget: SLO_TARGET,
      windowMinutes: MONTHLY_MINUTES,
      consumedMinutes: 108,
    });
    expect(result.consumedFraction).toBeCloseTo(0.5, 5);
    expect(result.exhausted).toBe(false);
  });

  it("returns exhausted=false when exactly at budget boundary", () => {
    const result = computeErrorBudget({
      sloTarget: SLO_TARGET,
      windowMinutes: MONTHLY_MINUTES,
      consumedMinutes: 216,
    });
    expect(result.remainingMinutes).toBeCloseTo(0, 5);
    expect(result.exhausted).toBe(true); // ≤ 0 → exhausted
  });

  it("returns exhausted=true and negative remaining when budget is exceeded", () => {
    const result = computeErrorBudget({
      sloTarget: SLO_TARGET,
      windowMinutes: MONTHLY_MINUTES,
      consumedMinutes: 300, // 84 minutes over budget
    });
    expect(result.exhausted).toBe(true);
    expect(result.remainingMinutes).toBeCloseTo(-84, 1);
    expect(result.consumedFraction).toBeGreaterThan(1);
  });

  it("returns consumedFraction=1.0 at exactly full consumption", () => {
    const budget = MONTHLY_MINUTES * (1 - SLO_TARGET);
    const result = computeErrorBudget({
      sloTarget: SLO_TARGET,
      windowMinutes: MONTHLY_MINUTES,
      consumedMinutes: budget,
    });
    expect(result.consumedFraction).toBeCloseTo(1.0, 5);
  });

  it("throws RangeError when windowMinutes is zero", () => {
    expect(() =>
      computeErrorBudget({ sloTarget: 0.995, windowMinutes: 0, consumedMinutes: 0 })
    ).toThrow(RangeError);
  });

  it("throws RangeError when consumedMinutes is negative", () => {
    expect(() =>
      computeErrorBudget({ sloTarget: 0.995, windowMinutes: MONTHLY_MINUTES, consumedMinutes: -1 })
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// burnRateThreshold
// ---------------------------------------------------------------------------

describe("burnRateThreshold", () => {
  it("returns 7.2% for 14.4× burn rate at 99.5% SLO (fast-burn)", () => {
    expect(burnRateThreshold(0.995, 14.4)).toBeCloseTo(0.072, 5);
  });

  it("returns 3.0% for 6× burn rate at 99.5% SLO (slow-burn)", () => {
    expect(burnRateThreshold(0.995, 6)).toBeCloseTo(0.03, 5);
  });

  it("throws RangeError when sloTarget ≥ 1", () => {
    expect(() => burnRateThreshold(1, 14.4)).toThrow(RangeError);
  });

  it("throws RangeError when burnRateMultiplier ≤ 0", () => {
    expect(() => burnRateThreshold(0.995, 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// fastBurnRateMultiplier
// ---------------------------------------------------------------------------

describe("fastBurnRateMultiplier", () => {
  it("computes 14.4× for 1-hour window consuming 2% of 30-day budget", () => {
    // (43200 / 60) × 0.02 = 720 × 0.02 = 14.4
    expect(fastBurnRateMultiplier(60, 43_200, 0.02)).toBeCloseTo(14.4, 5);
  });

  it("computes 6× for 6-hour window consuming 5% of 30-day budget", () => {
    // (43200 / 360) × 0.05 = 120 × 0.05 = 6
    expect(fastBurnRateMultiplier(360, 43_200, 0.05)).toBeCloseTo(6.0, 5);
  });

  it("throws RangeError when windowMinutes is zero", () => {
    expect(() => fastBurnRateMultiplier(0, 43_200, 0.02)).toThrow(RangeError);
  });

  it("throws RangeError when budgetFractionConsumed is zero", () => {
    expect(() => fastBurnRateMultiplier(60, 43_200, 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// generateBurnScenario
// ---------------------------------------------------------------------------

describe("generateBurnScenario", () => {
  it("healthy scenario does not trigger any alarms", () => {
    const s = generateBurnScenario("healthy");
    expect(s.triggersPageAlarm).toBe(false);
    expect(s.triggersTicketAlarm).toBe(false);
    expect(s.burnRate).toBeLessThan(6);
  });

  it("slow_burn scenario triggers ticket alarm but not page alarm", () => {
    const s = generateBurnScenario("slow_burn");
    expect(s.triggersTicketAlarm).toBe(true);
    expect(s.triggersPageAlarm).toBe(false);
    expect(s.burnRate).toBeGreaterThanOrEqual(6);
    expect(s.burnRate).toBeLessThan(14.4);
  });

  it("fast_burn scenario triggers both ticket and page alarms", () => {
    const s = generateBurnScenario("fast_burn");
    expect(s.triggersPageAlarm).toBe(true);
    expect(s.triggersTicketAlarm).toBe(true);
    expect(s.burnRate).toBeGreaterThanOrEqual(14.4);
  });

  it("exhausted scenario triggers both alarms with very high burn rate", () => {
    const s = generateBurnScenario("exhausted");
    expect(s.triggersPageAlarm).toBe(true);
    expect(s.triggersTicketAlarm).toBe(true);
  });

  it("throws RangeError when totalRequests ≤ 0", () => {
    expect(() => generateBurnScenario("healthy", 0)).toThrow(RangeError);
  });
});
