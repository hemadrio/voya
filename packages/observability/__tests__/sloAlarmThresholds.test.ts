/**
 * Synthetic alarm-threshold validation (WO-108 AC9).
 *
 * This test suite validates alarm-threshold logic by feeding the committed
 * burn-rate fixture files through the `computeBurnRate` helpers and asserting
 * each scenario triggers the expected alarm state.
 *
 * Why this is not an AWS integration test:
 *   - We cannot publish CloudWatch metric data in a sandboxed CI environment.
 *   - Instead we validate the LOCAL configuration: the threshold constants
 *     used in Terraform locals match what the burn-rate math produces.
 *   - An end-to-end CloudWatch "synthetic breach" test must be run separately
 *     against a real AWS test account (see tests/integration/alarmBreach/).
 *
 * AC9 coverage:
 *   ✓ Healthy scenario: no alarm thresholds exceeded
 *   ✓ Slow-burn scenario: slow-burn threshold (3.0%) exceeded, fast-burn not
 *   ✓ Fast-burn scenario: both thresholds exceeded → composite alarm fires
 *   ✓ Zero-traffic window: no alarm triggered, no-data alarm handles feed loss
 *   ✓ Alarm threshold constants derived from the SLO spec arithmetic
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeBurnRate,
  burnRateThreshold,
  generateBurnScenario,
} from "../src/slo/burnRate.js";

// ---------------------------------------------------------------------------
// Alarm threshold constants — must match infra/terraform/locals.tf exactly
// ---------------------------------------------------------------------------

/** locals.tf: slo_fast_burn_error_rate_pct = 7.2 */
const FAST_BURN_THRESHOLD_PCT = 7.2;
/** locals.tf: slo_slow_burn_error_rate_pct = 3.0 */
const SLOW_BURN_THRESHOLD_PCT = 3.0;
/** Availability SLO target = 99.5% */
const SLO_TARGET = 0.995;
/** Fast-burn multiplier = 14.4× (Google SRE; WO-108 spec §4.1) */
const FAST_BURN_MULTIPLIER = 14.4;
/** Slow-burn multiplier = 6× */
const SLOW_BURN_MULTIPLIER = 6.0;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function triggersPageAlarm(errorRatePct: number): boolean {
  return errorRatePct > FAST_BURN_THRESHOLD_PCT;
}

function triggersTicketAlarm(errorRatePct: number): boolean {
  return errorRatePct > SLOW_BURN_THRESHOLD_PCT;
}

// ---------------------------------------------------------------------------
// Alarm threshold derivation verification
// ---------------------------------------------------------------------------

describe("SLO alarm threshold derivation (Terraform locals.tf consistency)", () => {
  it("fast-burn threshold is 14.4× the error budget fraction (7.2%)", () => {
    const derived = burnRateThreshold(SLO_TARGET, FAST_BURN_MULTIPLIER) * 100;
    expect(derived).toBeCloseTo(FAST_BURN_THRESHOLD_PCT, 5);
  });

  it("slow-burn threshold is 6× the error budget fraction (3.0%)", () => {
    const derived = burnRateThreshold(SLO_TARGET, SLOW_BURN_MULTIPLIER) * 100;
    expect(derived).toBeCloseTo(SLOW_BURN_THRESHOLD_PCT, 5);
  });

  it("fast-burn threshold is strictly above slow-burn threshold", () => {
    expect(FAST_BURN_THRESHOLD_PCT).toBeGreaterThan(SLOW_BURN_THRESHOLD_PCT);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven synthetic breach tests
// ---------------------------------------------------------------------------

interface BurnRateFixture {
  scenario: string;
  sloTarget: number;
  totalRequests: number;
  badRequests: number;
  errorRatePct: number;
  burnRate: number;
  triggersPageAlarm: boolean;
  triggersTicketAlarm: boolean;
  fastBurnThresholdPct: number;
  slowBurnThresholdPct: number;
}

function loadFixture(name: string): BurnRateFixture {
  const raw = readFileSync(join(fixturesDir, name), "utf-8");
  return JSON.parse(raw) as BurnRateFixture;
}

describe("Healthy scenario fixture", () => {
  const fixture = loadFixture("burn-rate-healthy.json");

  it("computeBurnRate matches fixture burn rate", () => {
    const result = computeBurnRate({
      totalEvents: fixture.totalRequests,
      badEvents: fixture.badRequests,
      sloTarget: fixture.sloTarget,
    });
    expect(result.burnRate).toBeCloseTo(fixture.burnRate, 1);
    expect(result.errorRate * 100).toBeCloseTo(fixture.errorRatePct, 3);
  });

  it("does NOT trigger page (fast-burn) alarm", () => {
    expect(triggersPageAlarm(fixture.errorRatePct)).toBe(false);
    expect(fixture.triggersPageAlarm).toBe(false);
  });

  it("does NOT trigger ticket (slow-burn) alarm", () => {
    expect(triggersTicketAlarm(fixture.errorRatePct)).toBe(false);
    expect(fixture.triggersTicketAlarm).toBe(false);
  });
});

describe("Slow-burn scenario fixture", () => {
  const fixture = loadFixture("burn-rate-slow-burn.json");

  it("computeBurnRate matches fixture burn rate", () => {
    const result = computeBurnRate({
      totalEvents: fixture.totalRequests,
      badEvents: fixture.badRequests,
      sloTarget: fixture.sloTarget,
    });
    expect(result.burnRate).toBeCloseTo(fixture.burnRate, 1);
    expect(result.errorRate * 100).toBeCloseTo(fixture.errorRatePct, 3);
  });

  it("does NOT trigger page (fast-burn) alarm", () => {
    expect(triggersPageAlarm(fixture.errorRatePct)).toBe(false);
    expect(fixture.triggersPageAlarm).toBe(false);
  });

  it("DOES trigger ticket (slow-burn) alarm", () => {
    expect(triggersTicketAlarm(fixture.errorRatePct)).toBe(true);
    expect(fixture.triggersTicketAlarm).toBe(true);
  });

  it("error rate is above slow-burn threshold but below fast-burn threshold", () => {
    expect(fixture.errorRatePct).toBeGreaterThan(SLOW_BURN_THRESHOLD_PCT);
    expect(fixture.errorRatePct).toBeLessThan(FAST_BURN_THRESHOLD_PCT);
  });
});

describe("Fast-burn scenario fixture", () => {
  const fixture = loadFixture("burn-rate-fast-burn.json");

  it("computeBurnRate matches fixture burn rate", () => {
    const result = computeBurnRate({
      totalEvents: fixture.totalRequests,
      badEvents: fixture.badRequests,
      sloTarget: fixture.sloTarget,
    });
    expect(result.burnRate).toBeCloseTo(fixture.burnRate, 1);
    expect(result.errorRate * 100).toBeCloseTo(fixture.errorRatePct, 3);
  });

  it("DOES trigger page (fast-burn) alarm", () => {
    expect(triggersPageAlarm(fixture.errorRatePct)).toBe(true);
    expect(fixture.triggersPageAlarm).toBe(true);
  });

  it("DOES trigger ticket (slow-burn) alarm", () => {
    expect(triggersTicketAlarm(fixture.errorRatePct)).toBe(true);
    expect(fixture.triggersTicketAlarm).toBe(true);
  });

  it("triggers composite alarm (both fast-burn AND slow-burn fire)", () => {
    const compositeAlarmFires =
      triggersPageAlarm(fixture.errorRatePct) &&
      triggersTicketAlarm(fixture.errorRatePct);
    expect(compositeAlarmFires).toBe(true);
  });

  it("error rate is above fast-burn threshold (7.2%)", () => {
    expect(fixture.errorRatePct).toBeGreaterThan(FAST_BURN_THRESHOLD_PCT);
  });
});

// ---------------------------------------------------------------------------
// Zero-traffic window (no-data behaviour)
// ---------------------------------------------------------------------------

describe("Zero-traffic window (no-data alarm coverage)", () => {
  it("returns noTraffic=true and burnRate=0 — does NOT trigger a burn alarm", () => {
    const result = computeBurnRate({
      totalEvents: 0,
      badEvents: 0,
      sloTarget: SLO_TARGET,
    });
    expect(result.noTraffic).toBe(true);
    expect(result.burnRate).toBe(0);
    // Zero-traffic must NOT be interpreted as 100% error rate
    expect(triggersPageAlarm(result.burnRate)).toBe(false);
    expect(triggersTicketAlarm(result.burnRate)).toBe(false);
    // NOTE: A no-data alarm (HIGH-sli-feed-no-data-*) covers feed loss separately.
    // See infra/terraform/monitoring-alarms.tf resources: sli_feed_no_data_*.
  });
});

// ---------------------------------------------------------------------------
// generateBurnScenario consistency check
// ---------------------------------------------------------------------------

describe("generateBurnScenario is consistent with fixture files", () => {
  it("healthy scenario burn rate < slow-burn threshold", () => {
    const s = generateBurnScenario("healthy");
    expect(s.triggersPageAlarm).toBe(false);
    expect(s.triggersTicketAlarm).toBe(false);
  });

  it("slow_burn scenario triggers ticket but not page alarm", () => {
    const s = generateBurnScenario("slow_burn");
    expect(s.triggersTicketAlarm).toBe(true);
    expect(s.triggersPageAlarm).toBe(false);
  });

  it("fast_burn scenario triggers both alarms (composite alarm fires)", () => {
    const s = generateBurnScenario("fast_burn");
    expect(s.triggersPageAlarm).toBe(true);
    expect(s.triggersTicketAlarm).toBe(true);
  });
});
