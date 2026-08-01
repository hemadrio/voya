/**
 * Determinism test — verifies that running the same scenario twice produces
 * byte-identical reports (WO-063, AC3, Constraints).
 */

import { describe, it, expect } from "vitest";
import { runScenario } from "../runner.js";
import { buildReport, scoreRun } from "../report.js";
import { validateScenario } from "../schema.js";

// A simple self-contained scenario (no file I/O required)
const DETERMINISM_SCENARIO_RAW = {
  version: "1",
  id: "sc-001",
  description: "Happy path: single turn flight search with offer cards",
  principalType: "traveler",
  turns: [
    {
      userContent: "Find me flights from LHR to JFK",
      stubbedToolResponses: {
        "search_flights:0": {
          ok: true,
          data: [
            {
              id: "FL001",
              price: 489,
              currency: "USD",
              provenance: "AMADEUS",
              bookable: true,
              title: "LHR → JFK Economy",
              description: "7h non-stop",
            },
          ],
        },
      },
      scriptedModelTranscript: [
        [
          { type: "tool_call_start", toolCallId: "tc001", toolName: "search_flights" },
          { type: "tool_call_delta", toolCallId: "tc001", toolInputDelta: '{"origin":"LHR","destination":"JFK","departureDate":"2024-06-01","cabinClass":"economy","adults":1}' },
          { type: "tool_call_end", toolCallId: "tc001" },
          { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 120, outputTokens: 12 } },
        ],
        [
          { type: "text_delta", textDelta: "Here are some options for your trip." },
          { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 180, outputTokens: 20 } },
        ],
      ],
      expectations: {
        tools: ["search_flights"],
      },
    },
  ],
};

describe("Determinism — byte-identical repeat runs", () => {
  it("produces identical event lists across two consecutive runs", async () => {
    const scenario = validateScenario(DETERMINISM_SCENARIO_RAW, "determinism-test.json");

    const run1 = await runScenario(scenario);
    const run2 = await runScenario(scenario);

    expect(run1.turns).toHaveLength(run2.turns.length);

    for (let i = 0; i < run1.turns.length; i++) {
      const t1 = run1.turns[i];
      const t2 = run2.turns[i];
      // Event types and counts must be identical
      expect(t2?.events.map((e) => e.type)).toEqual(t1?.events.map((e) => e.type));
      // Token counts must be identical (driven by scripted transcript)
      expect(t2?.tokensIn).toBe(t1?.tokensIn);
      expect(t2?.tokensOut).toBe(t1?.tokensOut);
      // Latency must be identical (deterministic clock)
      expect(t2?.firstEventMs).toBe(t1?.firstEventMs);
      expect(t2?.totalMs).toBe(t1?.totalMs);
    }
  });

  it("produces byte-identical report JSON across two runs", async () => {
    const scenario = validateScenario(DETERMINISM_SCENARIO_RAW, "determinism-test.json");

    const run1 = await runScenario(scenario);
    const run2 = await runScenario(scenario);

    const report1 = buildReport([run1], [scenario], "2024-01-01T00:00:00.000Z");
    const report2 = buildReport([run2], [scenario], "2024-01-01T00:00:00.000Z");

    // Serialise with sorted keys for deterministic comparison
    const json1 = JSON.stringify(report1);
    const json2 = JSON.stringify(report2);

    expect(json2).toBe(json1);
  });
});
