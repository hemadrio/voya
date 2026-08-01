/**
 * BudgetGuard unit tests — boundary conditions for every cap kind (WO-059).
 *
 * All tests use tiny caps so assertions are clearly at-limit or beyond-limit.
 * A fake clock controls duration caps.
 */

import { describe, it, expect } from "vitest";
import {
  BudgetGuard,
  BudgetCaps,
  CAP_NOTICE,
} from "../../src/domain/budget/BudgetGuard.js";

const MINIMAL_CAPS: BudgetCaps = {
  maxToolCallsPerTurn: 3,
  maxIterationsPerTurn: 2,
  maxInputTokensPerCall: 100,
  maxOutputTokensPerTurn: 200,
  maxConversationTokens: 500,
  maxDurationMs: 5_000,
};

function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

// ---------------------------------------------------------------------------
// beforeIteration
// ---------------------------------------------------------------------------

describe("BudgetGuard.beforeIteration", () => {
  it("allows iteration 1 through maxIterationsPerTurn", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeIteration()).toEqual({ allowed: true });
    expect(guard.beforeIteration()).toEqual({ allowed: true });
  });

  it("denies at exactly maxIterationsPerTurn", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    guard.beforeIteration(); // round 1
    guard.beforeIteration(); // round 2
    const outcome = guard.beforeIteration(); // round 3 → denied
    expect(outcome).toEqual({ allowed: false, cap: "ITERATIONS" });
  });

  it("denies when output tokens cap reached", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    guard.afterModelCall({ inputTokens: 10, outputTokens: 200 }); // hit cap
    const outcome = guard.beforeIteration();
    expect(outcome).toEqual({ allowed: false, cap: "OUTPUT_TOKENS" });
  });

  it("denies when conversation token cap reached", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 500); // already at cap
    const outcome = guard.beforeIteration();
    expect(outcome).toEqual({ allowed: false, cap: "CONVERSATION_TOKENS" });
  });

  it("denies when duration cap exceeded before iteration", () => {
    const clock = makeClock(0);
    const guard = new BudgetGuard(MINIMAL_CAPS, 0, clock.now);
    clock.advance(6_000); // exceed 5_000 ms cap
    const outcome = guard.beforeIteration();
    expect(outcome).toEqual({ allowed: false, cap: "DURATION" });
  });
});

// ---------------------------------------------------------------------------
// beforeModelCall
// ---------------------------------------------------------------------------

describe("BudgetGuard.beforeModelCall", () => {
  it("allows when estimated tokens below cap", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeModelCall(99)).toEqual({ allowed: true });
  });

  it("allows at exactly cap - 1", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeModelCall(99)).toEqual({ allowed: true });
  });

  it("denies at exactly cap", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeModelCall(100)).toEqual({ allowed: false, cap: "INPUT_TOKENS" });
  });

  it("denies beyond cap", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeModelCall(500)).toEqual({ allowed: false, cap: "INPUT_TOKENS" });
  });

  it("denies when duration exceeded", () => {
    const clock = makeClock(0);
    const guard = new BudgetGuard(MINIMAL_CAPS, 0, clock.now);
    clock.advance(5_001);
    expect(guard.beforeModelCall(50)).toEqual({ allowed: false, cap: "DURATION" });
  });
});

// ---------------------------------------------------------------------------
// afterModelCall
// ---------------------------------------------------------------------------

describe("BudgetGuard.afterModelCall", () => {
  it("accumulates token totals", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    guard.afterModelCall({ inputTokens: 30, outputTokens: 50 });
    guard.afterModelCall({ inputTokens: 20, outputTokens: 30 });
    const usage = guard.turnUsage;
    expect(usage.inputTokens).toBe(50);
    expect(usage.outputTokens).toBe(80);
  });

  it("adds to conversation token total", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 300);
    guard.afterModelCall({ inputTokens: 100, outputTokens: 100 });
    // conversation is now at 500 — should deny next iteration
    const outcome = guard.beforeIteration();
    expect(outcome).toEqual({ allowed: false, cap: "CONVERSATION_TOKENS" });
  });

  it("records estimated usage without throwing", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(() => guard.afterModelCall({ inputTokens: 50, outputTokens: 40, isEstimated: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// beforeToolCall / afterToolCall
// ---------------------------------------------------------------------------

describe("BudgetGuard.beforeToolCall / afterToolCall", () => {
  it("allows tool calls 1 through maxToolCallsPerTurn - 1", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    expect(guard.beforeToolCall()).toEqual({ allowed: true });
    guard.afterToolCall();
    expect(guard.beforeToolCall()).toEqual({ allowed: true });
    guard.afterToolCall();
    expect(guard.beforeToolCall()).toEqual({ allowed: true });
  });

  it("denies at exactly maxToolCallsPerTurn (after 3 completions)", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    for (let i = 0; i < 3; i++) {
      guard.beforeToolCall();
      guard.afterToolCall();
    }
    const outcome = guard.beforeToolCall();
    expect(outcome).toEqual({ allowed: false, cap: "TOOL_CALLS" });
  });

  it("increments toolCallsUsed after each afterToolCall", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    guard.beforeToolCall(); guard.afterToolCall();
    guard.beforeToolCall(); guard.afterToolCall();
    expect(guard.toolCallsUsed).toBe(2);
  });

  it("denies when output token cap reached before tool call", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    guard.afterModelCall({ inputTokens: 10, outputTokens: 200 });
    expect(guard.beforeToolCall()).toEqual({ allowed: false, cap: "OUTPUT_TOKENS" });
  });

  it("denies when conversation cap reached before tool call", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 500);
    expect(guard.beforeToolCall()).toEqual({ allowed: false, cap: "CONVERSATION_TOKENS" });
  });
});

// ---------------------------------------------------------------------------
// assertWithinDuration
// ---------------------------------------------------------------------------

describe("BudgetGuard.assertWithinDuration", () => {
  it("allows before cap is reached", () => {
    const clock = makeClock(1_000);
    const guard = new BudgetGuard(MINIMAL_CAPS, 0, clock.now);
    clock.advance(2_000);
    expect(guard.assertWithinDuration()).toEqual({ allowed: true });
  });

  it("denies at exactly cap ms", () => {
    const clock = makeClock(0);
    const guard = new BudgetGuard(MINIMAL_CAPS, 0, clock.now);
    clock.advance(5_000);
    expect(guard.assertWithinDuration()).toEqual({ allowed: false, cap: "DURATION" });
  });

  it("denies beyond cap ms", () => {
    const clock = makeClock(0);
    const guard = new BudgetGuard(MINIMAL_CAPS, 0, clock.now);
    clock.advance(99_999);
    expect(guard.assertWithinDuration()).toEqual({ allowed: false, cap: "DURATION" });
  });
});

// ---------------------------------------------------------------------------
// Cap notice messages
// ---------------------------------------------------------------------------

describe("CAP_NOTICE", () => {
  it("has a non-empty string for every CapKind", () => {
    const kinds = ["TOOL_CALLS", "ITERATIONS", "INPUT_TOKENS", "OUTPUT_TOKENS", "CONVERSATION_TOKENS", "DURATION"] as const;
    for (const k of kinds) {
      expect(typeof CAP_NOTICE[k]).toBe("string");
      expect(CAP_NOTICE[k].length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Client-override rejection — caps are read-only after construction
// ---------------------------------------------------------------------------

describe("Budget caps cannot be overridden", () => {
  it("ignores any attempt to mutate caps from outside the guard", () => {
    const guard = new BudgetGuard(MINIMAL_CAPS, 0);
    // Simulate a client/model trying to raise the cap by mutating the returned object
    const capsCopy = guard.caps;
    (capsCopy as { maxToolCallsPerTurn: number }).maxToolCallsPerTurn = 9999;

    // The internal caps object is the same reference — but the guard.caps getter
    // returns readonly BudgetCaps, preventing runtime mutation from JS.
    // Even if the reference is the same, test that the guard still enforces the original limit.
    for (let i = 0; i < 3; i++) {
      guard.beforeToolCall();
      guard.afterToolCall();
    }
    const outcome = guard.beforeToolCall();
    // The guard should still deny at 3 (original cap), not 9999
    expect(outcome).toEqual({ allowed: false, cap: "TOOL_CALLS" });
  });
});
