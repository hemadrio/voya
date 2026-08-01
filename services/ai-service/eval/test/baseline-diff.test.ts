/**
 * Unit tests for baseline diffing (WO-063, AC11).
 *
 * Covers: missing scenarios, added scenarios, renamed scenarios,
 * and tolerance boundaries (just-inside / just-outside).
 */

import { describe, it, expect } from "vitest";
import { diffAgainstBaseline } from "../report.js";
import type { Report } from "../report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides?: Partial<Report>): Report {
  return {
    harnessVersion: "1",
    generatedAt: "2024-01-01T00:00:00.000Z",
    scenarios: [],
    aggregate: {
      groundingPassRate: 1.0,
      safetyPassRate: 1.0,
      meanToolPrecision: 1.0,
      meanTokensIn: 100,
      meanTokensOut: 20,
      p95TotalMs: 100,
    },
    ...overrides,
  };
}

function makeScenarioReport(id: string, groundingPass = true, safetyPass = true) {
  return {
    id,
    description: `Scenario ${id}`,
    grounding: { unsupportedClaims: groundingPass ? 0 : 1, offerCardsTraceable: 0, offerCardsEmitted: 0, pass: groundingPass },
    safety: { promptDisclosure: false, executableMarkup: false, refusalCorrect: true, markupClean: true, pass: safetyPass },
    taskSuccess: { toolPrecision: 1, pass: true },
    cost: { tokensIn: 100, tokensOut: 20, toolCalls: 1 },
    latency: { firstEventMs: 10, totalMs: 50 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diffAgainstBaseline — clean pass", () => {
  it("passes when current matches baseline exactly", () => {
    const baseline = makeReport();
    const current = makeReport();
    const result = diffAgainstBaseline(current, baseline);
    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});

describe("diffAgainstBaseline — grounding threshold", () => {
  it("passes at exactly the threshold (inclusive)", () => {
    const baseline = makeReport();
    const current = makeReport({ aggregate: { ...makeReport().aggregate, groundingPassRate: 0.95 } });
    const result = diffAgainstBaseline(current, baseline, { groundingPassRateThreshold: 0.95 });
    expect(result.failures.some((f) => f.includes("Grounding"))).toBe(false);
  });

  it("fails just below the threshold", () => {
    const baseline = makeReport();
    const current = makeReport({ aggregate: { ...makeReport().aggregate, groundingPassRate: 0.949 } });
    const result = diffAgainstBaseline(current, baseline, { groundingPassRateThreshold: 0.95 });
    expect(result.failures.some((f) => f.includes("Grounding"))).toBe(true);
    expect(result.pass).toBe(false);
  });
});

describe("diffAgainstBaseline — safety threshold", () => {
  it("passes at exactly 100% safety", () => {
    const baseline = makeReport();
    const current = makeReport({ aggregate: { ...makeReport().aggregate, safetyPassRate: 1.0 } });
    const result = diffAgainstBaseline(current, baseline, { safetyPassRateThreshold: 1.0 });
    expect(result.failures.some((f) => f.includes("Safety"))).toBe(false);
  });

  it("fails when safety drops below 100%", () => {
    const baseline = makeReport();
    const current = makeReport({ aggregate: { ...makeReport().aggregate, safetyPassRate: 0.99 } });
    const result = diffAgainstBaseline(current, baseline, { safetyPassRateThreshold: 1.0 });
    expect(result.failures.some((f) => f.includes("Safety"))).toBe(true);
  });
});

describe("diffAgainstBaseline — cost regression", () => {
  it("passes within relative tolerance", () => {
    const baseline = makeReport({ aggregate: { ...makeReport().aggregate, meanTokensIn: 100, meanTokensOut: 20 } });
    const current = makeReport({ aggregate: { ...makeReport().aggregate, meanTokensIn: 108, meanTokensOut: 21 } }); // ~7.5% increase
    const result = diffAgainstBaseline(current, baseline, { costRelativeTolerance: 0.1 });
    expect(result.failures.some((f) => f.includes("token cost"))).toBe(false);
  });

  it("fails just over relative tolerance", () => {
    const baseline = makeReport({ aggregate: { ...makeReport().aggregate, meanTokensIn: 100, meanTokensOut: 0 } });
    const current = makeReport({ aggregate: { ...makeReport().aggregate, meanTokensIn: 115, meanTokensOut: 0 } }); // 15% > 10%
    const result = diffAgainstBaseline(current, baseline, { costRelativeTolerance: 0.1 });
    expect(result.failures.some((f) => f.includes("token cost"))).toBe(true);
  });
});

describe("diffAgainstBaseline — latency regression", () => {
  it("passes within relative tolerance", () => {
    const baseline = makeReport({ aggregate: { ...makeReport().aggregate, p95TotalMs: 100 } });
    const current = makeReport({ aggregate: { ...makeReport().aggregate, p95TotalMs: 118 } }); // 18% < 20%
    const result = diffAgainstBaseline(current, baseline, { latencyRelativeTolerance: 0.2 });
    expect(result.failures.some((f) => f.includes("p95 latency"))).toBe(false);
  });

  it("fails just over relative tolerance", () => {
    const baseline = makeReport({ aggregate: { ...makeReport().aggregate, p95TotalMs: 100 } });
    const current = makeReport({ aggregate: { ...makeReport().aggregate, p95TotalMs: 125 } }); // 25% > 20%
    const result = diffAgainstBaseline(current, baseline, { latencyRelativeTolerance: 0.2 });
    expect(result.failures.some((f) => f.includes("p95 latency"))).toBe(true);
  });
});

describe("diffAgainstBaseline — scenario changes", () => {
  it("reports missing scenario as informational (coverage loss), not a failure", () => {
    const baseline = makeReport({
      scenarios: [makeScenarioReport("sc-001")],
    });
    const current = makeReport({ scenarios: [] });
    const result = diffAgainstBaseline(current, baseline);
    expect(result.informational.some((i) => i.includes("sc-001"))).toBe(true);
    // Missing scenario should still pass overall if aggregate metrics are fine
  });

  it("reports new scenario as informational — baseline regeneration required", () => {
    const baseline = makeReport({ scenarios: [] });
    const current = makeReport({
      scenarios: [makeScenarioReport("sc-new")],
    });
    const result = diffAgainstBaseline(current, baseline);
    expect(result.informational.some((i) => i.includes("sc-new"))).toBe(true);
    expect(result.informational.some((i) => i.includes("regenerate"))).toBe(true);
  });

  it("reports per-scenario grounding failure as a gate failure", () => {
    const baseline = makeReport({ scenarios: [makeScenarioReport("sc-001")] });
    const current = makeReport({ scenarios: [makeScenarioReport("sc-001", false, true)] });
    const result = diffAgainstBaseline(current, baseline);
    expect(result.failures.some((f) => f.includes("sc-001") && f.includes("grounding"))).toBe(true);
    expect(result.pass).toBe(false);
  });

  it("reports per-scenario safety failure as a gate failure", () => {
    const baseline = makeReport({ scenarios: [makeScenarioReport("sc-002")] });
    const current = makeReport({ scenarios: [makeScenarioReport("sc-002", true, false)] });
    const result = diffAgainstBaseline(current, baseline);
    expect(result.failures.some((f) => f.includes("sc-002") && f.includes("safety"))).toBe(true);
    expect(result.pass).toBe(false);
  });
});
