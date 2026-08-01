/**
 * Burn-rate and error-budget calculation helpers.
 *
 * All functions are pure and injectable with a Clock so they are fully
 * unit-testable without any AWS dependency.
 *
 * Design decisions:
 *   - Throws on inconsistent inputs (negative counts, zero-length window)
 *     rather than returning silently wrong numbers (see Error Handling in WO-108).
 *   - Zero-traffic window returns burnRate = 0 and remainingBudgetFraction = 1.0,
 *     NOT a false alarm — a no-data alarm handles feed loss separately.
 *   - All durations are in milliseconds unless the parameter name says Minutes/Hours.
 *
 * Reference: Google SRE "Alerting on SLOs" chapter; two-window multi-burn-rate model.
 */

// ---------------------------------------------------------------------------
// Clock interface (injectable for testing)
// ---------------------------------------------------------------------------

export interface SLOClock {
  nowMs(): number;
}

export class SystemSLOClock implements SLOClock {
  nowMs(): number {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function assertNonNegative(value: number, name: string): void {
  if (value < 0) {
    throw new RangeError(`${name} must be non-negative; got ${value}`);
  }
}

function assertPositive(value: number, name: string): void {
  if (value <= 0) {
    throw new RangeError(`${name} must be positive; got ${value}`);
  }
}

function assertLessEqual(a: number, b: number, nameA: string, nameB: string): void {
  if (a > b) {
    throw new RangeError(`${nameA} (${a}) must be ≤ ${nameB} (${b})`);
  }
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface BurnRateInput {
  /** Total requests (or probe-minutes) in the window. Must be ≥ 0. */
  readonly totalEvents: number;
  /** Bad events (errors, probe failures) in the same window. Must be ≤ totalEvents. */
  readonly badEvents: number;
  /** The SLO target as a fraction in (0, 1). Example: 0.995 for 99.5%. */
  readonly sloTarget: number;
}

export interface BurnRateResult {
  /** Measured error rate (badEvents / totalEvents), or 0 when totalEvents = 0. */
  readonly errorRate: number;
  /**
   * Burn rate multiplier: how many times faster than nominal the budget is
   * being consumed. errorRate / (1 - sloTarget).
   * Returns 0 when there is no traffic (zero-traffic is not a burn event).
   */
  readonly burnRate: number;
  /**
   * True when there are no events in the window.
   * Callers must NOT treat this as a healthy signal — raise a no-data alarm instead.
   */
  readonly noTraffic: boolean;
}

export interface ErrorBudgetInput {
  /** The SLO target as a fraction in (0, 1). */
  readonly sloTarget: number;
  /** Window duration in minutes (e.g., 30 days = 43 200 minutes). */
  readonly windowMinutes: number;
  /** Minutes already consumed (bad minutes from probe failures). Must be ≥ 0. */
  readonly consumedMinutes: number;
}

export interface ErrorBudgetResult {
  /** Total allowed bad minutes in the window. */
  readonly budgetMinutes: number;
  /** Budget consumed so far. */
  readonly consumedMinutes: number;
  /** Budget remaining (may be negative when exhausted). */
  readonly remainingMinutes: number;
  /** Consumption fraction in [0, ∞). Values > 1.0 indicate exhaustion. */
  readonly consumedFraction: number;
  /** True when the budget is at or below zero. */
  readonly exhausted: boolean;
}

// ---------------------------------------------------------------------------
// Burn-rate calculation
// ---------------------------------------------------------------------------

/**
 * Compute the instantaneous burn rate from a sample window.
 *
 * @throws RangeError when badEvents > totalEvents or either is negative.
 */
export function computeBurnRate(input: BurnRateInput): BurnRateResult {
  const { totalEvents, badEvents, sloTarget } = input;

  assertNonNegative(totalEvents, "totalEvents");
  assertNonNegative(badEvents, "badEvents");
  assertLessEqual(badEvents, totalEvents, "badEvents", "totalEvents");

  if (sloTarget <= 0 || sloTarget >= 1) {
    throw new RangeError(`sloTarget must be in (0, 1); got ${sloTarget}`);
  }

  if (totalEvents === 0) {
    return { errorRate: 0, burnRate: 0, noTraffic: true };
  }

  const errorRate = badEvents / totalEvents;
  const errorBudget = 1 - sloTarget;
  const burnRate = errorRate / errorBudget;

  return { errorRate, burnRate, noTraffic: false };
}

// ---------------------------------------------------------------------------
// Error budget remaining
// ---------------------------------------------------------------------------

/**
 * Compute the remaining error budget for a measurement window.
 *
 * @throws RangeError on invalid inputs.
 */
export function computeErrorBudget(input: ErrorBudgetInput): ErrorBudgetResult {
  const { sloTarget, windowMinutes, consumedMinutes } = input;

  if (sloTarget <= 0 || sloTarget >= 1) {
    throw new RangeError(`sloTarget must be in (0, 1); got ${sloTarget}`);
  }
  assertPositive(windowMinutes, "windowMinutes");
  assertNonNegative(consumedMinutes, "consumedMinutes");

  const budgetMinutes = windowMinutes * (1 - sloTarget);
  const remainingMinutes = budgetMinutes - consumedMinutes;
  const consumedFraction = budgetMinutes > 0 ? consumedMinutes / budgetMinutes : 0;
  const exhausted = remainingMinutes <= 0;

  return {
    budgetMinutes,
    consumedMinutes,
    remainingMinutes,
    consumedFraction,
    exhausted,
  };
}

// ---------------------------------------------------------------------------
// Multi-window burn-rate alarm threshold helpers
// ---------------------------------------------------------------------------

/**
 * Compute the error-rate threshold for a multi-window burn-rate alarm.
 *
 * Example (availability 99.5 % SLO, fast-burn):
 *   burnRateMultiplier = 14.4
 *   errorBudgetFraction = 1 - 0.995 = 0.005
 *   threshold = 14.4 × 0.005 = 0.072 (7.2 %)
 */
export function burnRateThreshold(
  sloTarget: number,
  burnRateMultiplier: number,
): number {
  if (sloTarget <= 0 || sloTarget >= 1) {
    throw new RangeError(`sloTarget must be in (0, 1); got ${sloTarget}`);
  }
  assertPositive(burnRateMultiplier, "burnRateMultiplier");
  return (1 - sloTarget) * burnRateMultiplier;
}

/**
 * Compute the burn-rate multiplier that would exhaust the monthly budget
 * if sustained for a given window (the "fast-burn" model).
 *
 * Formula: burnRate = (windowHours / monthHours) × (budgetFractionConsumed / 1)
 *   rearranged: burnRate = (monthMinutes / windowMinutes) × budgetFractionConsumed
 *
 * Example: fast-burn consumes 2 % of monthly budget in 1 hour:
 *   burnRate = (43200 / 60) × 0.02 = 720 × 0.02 = 14.4
 */
export function fastBurnRateMultiplier(
  windowMinutes: number,
  monthMinutes: number,
  budgetFractionConsumed: number,
): number {
  assertPositive(windowMinutes, "windowMinutes");
  assertPositive(monthMinutes, "monthMinutes");
  if (budgetFractionConsumed <= 0 || budgetFractionConsumed > 1) {
    throw new RangeError(
      `budgetFractionConsumed must be in (0, 1]; got ${budgetFractionConsumed}`,
    );
  }
  return (monthMinutes / windowMinutes) * budgetFractionConsumed;
}

// ---------------------------------------------------------------------------
// Scenario helpers for fixture generation
// ---------------------------------------------------------------------------

export type BurnScenario = "healthy" | "fast_burn" | "slow_burn" | "exhausted";

export interface ScenarioMetrics {
  readonly scenario: BurnScenario;
  readonly totalRequests: number;
  readonly badRequests: number;
  readonly errorRatePct: number;
  readonly burnRate: number;
  /** Whether this scenario should trigger the fast-burn alarm (≥ 7.2 % for 99.5 % SLO). */
  readonly triggersPageAlarm: boolean;
  /** Whether this scenario should trigger the slow-burn alarm (≥ 3.0 % for 99.5 % SLO). */
  readonly triggersTicketAlarm: boolean;
}

/**
 * Generate representative metric values for each burn scenario given a 99.5 % SLO.
 * Used by fixture files and synthetic breach tests.
 */
export function generateBurnScenario(
  scenario: BurnScenario,
  totalRequests = 10_000,
): ScenarioMetrics {
  assertPositive(totalRequests, "totalRequests");

  const SLO_TARGET = 0.995;
  const FAST_BURN_THRESHOLD_PCT = 7.2;
  const SLOW_BURN_THRESHOLD_PCT = 3.0;

  let errorRatePct: number;

  switch (scenario) {
    case "healthy":
      errorRatePct = 0.1; // well under 0.5% budget
      break;
    case "slow_burn":
      errorRatePct = 4.0; // above 3.0% slow-burn threshold, below 7.2% fast-burn
      break;
    case "fast_burn":
      errorRatePct = 8.5; // above 7.2% fast-burn threshold
      break;
    case "exhausted":
      errorRatePct = 15.0; // clearly exhausting
      break;
  }

  const badRequests = Math.round(totalRequests * errorRatePct / 100);
  const burnRateResult = computeBurnRate({
    totalEvents: totalRequests,
    badEvents: badRequests,
    sloTarget: SLO_TARGET,
  });

  return {
    scenario,
    totalRequests,
    badRequests,
    errorRatePct,
    burnRate: burnRateResult.burnRate,
    triggersPageAlarm: errorRatePct >= FAST_BURN_THRESHOLD_PCT,
    triggersTicketAlarm: errorRatePct >= SLOW_BURN_THRESHOLD_PCT,
  };
}
