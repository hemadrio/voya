/**
 * Unit tests for the additive-versus-breaking classifier and version gate.
 *
 * Each test category uses the committed fixtures in
 * test/compatibility/fixtures/ so the harness runs fully offline.
 */
import { describe, it, expect } from "./test-helpers.js";
import { classify, versionGate } from "./classifier.js";
import type { JsonSchema } from "../../scripts/zod-to-json-schema.js";
import additiveFixture from "./fixtures/additive.json" with { type: "json" };
import breakingFixture from "./fixtures/breaking.json" with { type: "json" };
import noOpFixture from "./fixtures/no-op.json" with { type: "json" };

type ChangeFixture = {
  description: string;
  schemaKind: "request" | "response" | "other";
  before: JsonSchema;
  after: JsonSchema;
};

describe("classifier — no-op", () => {
  const f = noOpFixture as ChangeFixture;
  it("returns no-op for identical schemas", () => {
    const result = classify(f.before, f.after);
    expect(result.classification).toBe("no-op");
    expect(result.changes).toHaveLength(0);
  });
});

describe("classifier — additive", () => {
  const f = additiveFixture as ChangeFixture;

  it("detects new optional property as additive", () => {
    const result = classify(f.before, f.after, "", f.schemaKind);
    expect(result.classification).toBe("additive");
  });

  it("includes the added property in the change list", () => {
    const result = classify(f.before, f.after, "", f.schemaKind);
    const added = result.changes.find((c) => c.reason.includes("cancelledAt"));
    expect(added).toBeDefined();
    expect(added?.kind).toBe("additive");
  });

  it("classifies added enum value as additive on a response schema", () => {
    const result = classify(f.before, f.after, "", "response");
    const enumChange = result.changes.find((c) => c.reason.includes("CANCELLED"));
    expect(enumChange?.kind).toBe("additive");
  });
});

describe("classifier — breaking", () => {
  const f = breakingFixture as ChangeFixture;

  it("returns breaking for removed required property", () => {
    const result = classify(f.before, f.after, "", f.schemaKind);
    expect(result.classification).toBe("breaking");
  });

  it("includes the removed property in the change list", () => {
    const result = classify(f.before, f.after, "", f.schemaKind);
    const removed = result.changes.find((c) => c.reason.includes("currency"));
    expect(removed).toBeDefined();
    expect(removed?.kind).toBe("breaking");
  });

  it("classifies removed enum value as breaking", () => {
    const result = classify(f.before, f.after, "", f.schemaKind);
    const enumChange = result.changes.find((c) => c.reason.includes("CAR"));
    expect(enumChange?.kind).toBe("breaking");
  });

  it("added enum value on request schema is breaking", () => {
    const before: JsonSchema = {
      type: "object",
      properties: { mode: { enum: ["A", "B"], type: "string" } },
      required: ["mode"],
    };
    const after: JsonSchema = {
      type: "object",
      properties: { mode: { enum: ["A", "B", "C"], type: "string" } },
      required: ["mode"],
    };
    const result = classify(before, after, "", "request");
    const added = result.changes.find((c) => c.reason.includes("C"));
    expect(added?.kind).toBe("breaking");
  });
});

describe("classifier — property required changes", () => {
  it("existing optional property made required is breaking", () => {
    const before: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };
    const after: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const result = classify(before, after);
    expect(result.classification).toBe("breaking");
    const change = result.changes.find((c) => c.reason.includes("made required"));
    expect(change).toBeDefined();
  });

  it("required property made optional is additive", () => {
    const before: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const after: JsonSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    };
    const result = classify(before, after);
    expect(result.classification).toBe("additive");
  });
});

describe("classifier — type changes", () => {
  it("string to integer type change is breaking", () => {
    const before: JsonSchema = { type: "string" };
    const after: JsonSchema = { type: "integer" };
    const result = classify(before, after);
    expect(result.classification).toBe("breaking");
  });
});

describe("version gate", () => {
  it("passes when change is additive (no version bump required)", () => {
    const f = additiveFixture as ChangeFixture;
    const result = versionGate(f.before, f.after, "0.1.0", "0.1.0", "response");
    expect(result.passed).toBe(true);
  });

  it("passes when change is no-op", () => {
    const f = noOpFixture as ChangeFixture;
    const result = versionGate(f.before, f.after, "0.1.0", "0.1.0");
    expect(result.passed).toBe(true);
  });

  it("fails when breaking change without major version bump", () => {
    const f = breakingFixture as ChangeFixture;
    const result = versionGate(f.before, f.after, "0.1.0", "0.2.0", "request");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("major-version bump");
  });

  it("passes when breaking change accompanied by major version bump", () => {
    const f = breakingFixture as ChangeFixture;
    const result = versionGate(f.before, f.after, "0.1.0", "1.0.0", "request");
    expect(result.passed).toBe(true);
  });

  it("reports classification alongside gate result", () => {
    const f = breakingFixture as ChangeFixture;
    const result = versionGate(f.before, f.after, "1.0.0", "1.1.0", "request");
    expect(result.classification).toBe("breaking");
  });
});
