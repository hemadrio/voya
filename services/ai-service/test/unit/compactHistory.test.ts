/**
 * compactHistory unit tests (WO-059).
 */

import { describe, it, expect } from "vitest";
import { compactHistory, CompactionError, SLOTS_SUMMARY_PREFIX } from "../../src/domain/budget/compactHistory.js";
import type { ModelMessage } from "../../src/domain/orchestrator/ConversationOrchestrator.js";

const msg = (role: ModelMessage["role"], content: string): ModelMessage => ({ role, content });

// Make a large message that definitely exceeds a small budget
const bigContent = "x".repeat(3500); // ~1000 tokens at 3.5 chars/token

describe("compactHistory", () => {
  it("returns input unchanged when already within budget", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "world"),
    ];
    const result = compactHistory(messages, 10_000);
    expect(result).toEqual(messages);
    expect(result).not.toBe(messages); // always a new array
  });

  it("drops oldest non-protected message first", () => {
    const messages = [
      msg("user", "first old message"),
      msg("assistant", "some reply to drop"),
      msg("user", "final question?"),
    ];
    // Set a budget that forces dropping something — 50 tokens should require dropping the old turn
    const result = compactHistory(messages, 50);
    expect(result).not.toContainEqual(msg("assistant", "some reply to drop"));
    // Must retain the last user message
    expect(result).toContainEqual(msg("user", "final question?"));
  });

  it("always retains the last user message", () => {
    const messages = [
      msg("user", "old user msg"),
      msg("assistant", "old assistant"),
      msg("user", "new user msg"),
    ];
    const result = compactHistory(messages, 20);
    expect(result.some((m) => m.role === "user" && m.content === "new user msg")).toBe(true);
  });

  it("always retains the resolved-slots summary", () => {
    const messages = [
      msg("assistant", `${SLOTS_SUMMARY_PREFIX} {"destination":"Paris"}`),
      msg("user", "old question"),
      msg("assistant", "old answer"),
      msg("user", "final question"),
    ];
    const result = compactHistory(messages, 30);
    expect(result.some((m) => m.content.startsWith(SLOTS_SUMMARY_PREFIX))).toBe(true);
  });

  it("throws CompactionError(OVERSIZED_AFTER_COMPACTION) when only protected messages remain", () => {
    const messages = [
      msg("assistant", `${SLOTS_SUMMARY_PREFIX} slots`),
      msg("user", "a".repeat(3500)), // last user msg — protected + large
    ];
    expect(() => compactHistory(messages, 10)).toThrow(CompactionError);
    try {
      compactHistory(messages, 10);
    } catch (e) {
      expect((e as CompactionError).reason).toBe("OVERSIZED_AFTER_COMPACTION");
    }
  });

  it("throws CompactionError(SINGLE_USER_MESSAGE_TOO_LARGE) when single user msg alone too large", () => {
    const messages = [msg("user", bigContent)];
    expect(() => compactHistory(messages, 10)).toThrow(CompactionError);
    try {
      compactHistory(messages, 10);
    } catch (e) {
      expect((e as CompactionError).reason).toBe("SINGLE_USER_MESSAGE_TOO_LARGE");
    }
  });

  it("does not mutate the original array", () => {
    const messages = [
      msg("user", "old"),
      msg("assistant", "old reply"),
      msg("user", "new"),
    ];
    const original = [...messages];
    compactHistory(messages, 10);
    expect(messages).toEqual(original);
  });
});
