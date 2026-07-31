/**
 * Unit tests for tag-policy.ts — WO-089.
 *
 * Covers:
 *   - parsePlanJson: valid JSON, malformed JSON, non-object JSON
 *   - skipReason: data source, delete-only, no-op, non-taggable, non-aws provider
 *   - checkResourceChange: fully tagged, missing one tag, missing all tags,
 *     tags_all absent, tags_all fully unknown (computed), delete-only skipped
 *   - checkPlan: fixture files for fully-tagged, missing-tag, non-taggable, malformed
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  MANDATORY_TAGS,
  NON_TAGGABLE_RESOURCE_TYPES,
  parsePlanJson,
  skipReason,
  checkResourceChange,
  checkPlan,
  type ResourceChange,
  type TerraformPlanJson,
} from "./tag-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeChange(
  type: string,
  actions: string[],
  mode: "managed" | "data" = "managed",
  tagsAll?: Record<string, string> | null | undefined,
  tagsAllUnknown = false,
  providerName = "registry.terraform.io/hashicorp/aws"
): ResourceChange {
  const after: Record<string, unknown> =
    tagsAll === undefined ? {} : tagsAll === null ? {} : { tags_all: tagsAll };
  const after_unknown: Record<string, unknown> = tagsAllUnknown
    ? { tags_all: true }
    : {};

  return {
    address: `${type}.example`,
    mode,
    type,
    name: "example",
    provider_name: providerName,
    change: {
      actions,
      before: null,
      after: tagsAll === null ? null : after,
      after_unknown,
    },
  };
}

function allFiveTagsAll(): Record<string, string> {
  return {
    Service: "travel-platform",
    Environment: "production",
    CostCentre: "platform-prod",
    Owner: "platform-team",
    DataClassification: "Confidential",
  };
}

// ── MANDATORY_TAGS ────────────────────────────────────────────────────────────

describe("MANDATORY_TAGS", () => {
  it("contains exactly five tags", () => {
    expect(MANDATORY_TAGS).toHaveLength(5);
  });

  it("contains the expected tag names", () => {
    expect(MANDATORY_TAGS).toContain("Service");
    expect(MANDATORY_TAGS).toContain("Environment");
    expect(MANDATORY_TAGS).toContain("CostCentre");
    expect(MANDATORY_TAGS).toContain("Owner");
    expect(MANDATORY_TAGS).toContain("DataClassification");
  });
});

// ── NON_TAGGABLE_RESOURCE_TYPES ───────────────────────────────────────────────

describe("NON_TAGGABLE_RESOURCE_TYPES", () => {
  it("contains aws_iam_role_policy_attachment", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("aws_iam_role_policy_attachment")).toBe(true);
  });

  it("contains aws_route", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("aws_route")).toBe(true);
  });

  it("contains aws_appautoscaling_policy", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("aws_appautoscaling_policy")).toBe(true);
  });

  it("contains null_resource", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("null_resource")).toBe(true);
  });

  it("does NOT contain aws_vpc (taggable)", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("aws_vpc")).toBe(false);
  });

  it("does NOT contain aws_ecs_service (taggable)", () => {
    expect(NON_TAGGABLE_RESOURCE_TYPES.has("aws_ecs_service")).toBe(false);
  });
});

// ── parsePlanJson ─────────────────────────────────────────────────────────────

describe("parsePlanJson", () => {
  it("parses a valid plan JSON string", () => {
    const plan = parsePlanJson('{"format_version":"1.2","resource_changes":[]}');
    expect(plan.format_version).toBe("1.2");
    expect(plan.resource_changes).toHaveLength(0);
  });

  it("parses a plan with no resource_changes key (returns undefined)", () => {
    const plan = parsePlanJson('{"format_version":"1.2"}');
    expect(plan.resource_changes).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePlanJson("{ not valid json")).toThrow(/not valid JSON/i);
  });

  it("throws on a JSON array", () => {
    expect(() => parsePlanJson("[]")).toThrow(/must be a JSON object/i);
  });

  it("throws on a JSON string", () => {
    expect(() => parsePlanJson('"just a string"')).toThrow(/must be a JSON object/i);
  });
});

// ── skipReason ────────────────────────────────────────────────────────────────

describe("skipReason", () => {
  it("skips data sources", () => {
    const change = makeChange("aws_vpc", ["read"], "data");
    expect(skipReason(change)).toBe("data source");
  });

  it("skips delete-only changes", () => {
    const change = makeChange("aws_vpc", ["delete"]);
    expect(skipReason(change)).toBe("delete-only");
  });

  it("skips no-op changes", () => {
    const change = makeChange("aws_vpc", ["no-op"]);
    expect(skipReason(change)).toBe("no-op");
  });

  it("skips non-taggable resource types", () => {
    const change = makeChange("aws_iam_role_policy_attachment", ["create"]);
    expect(skipReason(change)).toBe("non-taggable");
  });

  it("skips resources from non-aws providers", () => {
    const change = makeChange(
      "random_string",
      ["create"],
      "managed",
      undefined,
      false,
      "registry.terraform.io/hashicorp/random"
    );
    expect(skipReason(change)).toMatch(/non-aws provider/);
  });

  it("does NOT skip a taggable create", () => {
    const change = makeChange("aws_vpc", ["create"], "managed", allFiveTagsAll());
    expect(skipReason(change)).toBeNull();
  });

  it("does NOT skip an update", () => {
    const change = makeChange("aws_security_group", ["update"], "managed", allFiveTagsAll());
    expect(skipReason(change)).toBeNull();
  });

  it("does NOT skip create+delete (replace)", () => {
    const change = makeChange("aws_vpc", ["create", "delete"], "managed", allFiveTagsAll());
    expect(skipReason(change)).toBeNull();
  });
});

// ── checkResourceChange ───────────────────────────────────────────────────────

describe("checkResourceChange — compliant resources", () => {
  it("returns null when all five mandatory tags are present", () => {
    const change = makeChange("aws_vpc", ["create"], "managed", allFiveTagsAll());
    expect(checkResourceChange(change)).toBeNull();
  });

  it("returns null for a delete-only change (no new resource)", () => {
    const change = makeChange("aws_vpc", ["delete"], "managed", null);
    expect(checkResourceChange(change)).toBeNull();
  });

  it("returns null for a non-taggable resource type", () => {
    const change = makeChange("aws_route", ["create"]);
    expect(checkResourceChange(change)).toBeNull();
  });

  it("returns null for a data source", () => {
    const change = makeChange("aws_vpc", ["read"], "data");
    expect(checkResourceChange(change)).toBeNull();
  });

  it("returns null when tags_all is fully unknown (computed at apply time)", () => {
    const change = makeChange("aws_vpc", ["create"], "managed", undefined, true);
    expect(checkResourceChange(change)).toBeNull();
  });
});

describe("checkResourceChange — violations", () => {
  it("reports a violation when tags_all is absent", () => {
    const change: ResourceChange = {
      address: "aws_vpc.main",
      mode: "managed",
      type: "aws_vpc",
      name: "main",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: {
        actions: ["create"],
        before: null,
        after: { cidr_block: "10.0.0.0/16" }, // no tags_all key
        after_unknown: {},
      },
    };
    const v = checkResourceChange(change);
    expect(v).not.toBeNull();
    expect(v!.tagsAllAbsent).toBe(true);
    expect(v!.missingTags).toHaveLength(5);
    expect(v!.address).toBe("aws_vpc.main");
  });

  it("reports a violation when one mandatory tag is missing", () => {
    const tags = allFiveTagsAll();
    delete (tags as Record<string, string>)["DataClassification"];
    const change = makeChange("aws_security_group", ["create"], "managed", tags);
    const v = checkResourceChange(change);
    expect(v).not.toBeNull();
    expect(v!.missingTags).toEqual(["DataClassification"]);
    expect(v!.tagsAllAbsent).toBe(false);
  });

  it("reports a violation when multiple mandatory tags are missing", () => {
    const change = makeChange("aws_ecs_service", ["create"], "managed", {
      Service: "travel-platform",
      Environment: "production",
    });
    const v = checkResourceChange(change);
    expect(v).not.toBeNull();
    expect(v!.missingTags).toContain("CostCentre");
    expect(v!.missingTags).toContain("Owner");
    expect(v!.missingTags).toContain("DataClassification");
    expect(v!.missingTags).toHaveLength(3);
  });

  it("reports a violation when all mandatory tags are missing", () => {
    const change = makeChange("aws_rds_cluster", ["create"], "managed", {});
    const v = checkResourceChange(change);
    expect(v).not.toBeNull();
    expect(v!.missingTags).toHaveLength(5);
  });

  it("reports a violation when a tag value is an empty string", () => {
    const tags = allFiveTagsAll();
    (tags as Record<string, string>)["CostCentre"] = "";
    const change = makeChange("aws_vpc", ["create"], "managed", tags);
    const v = checkResourceChange(change);
    expect(v).not.toBeNull();
    expect(v!.missingTags).toContain("CostCentre");
  });
});

// ── checkPlan — fixture files ─────────────────────────────────────────────────

describe("checkPlan — plan-fully-tagged.json", () => {
  it("returns no violations for a fully-tagged plan", () => {
    const raw = readFileSync(join(FIXTURES, "plan-fully-tagged.json"), "utf-8");
    const plan = parsePlanJson(raw);
    const violations = checkPlan(plan);
    expect(violations).toHaveLength(0);
  });
});

describe("checkPlan — plan-missing-one-tag.json", () => {
  it("returns violations for resources missing mandatory tags", () => {
    const raw = readFileSync(join(FIXTURES, "plan-missing-one-tag.json"), "utf-8");
    const plan = parsePlanJson(raw);
    const violations = checkPlan(plan);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("names the missing tag in the violation", () => {
    const raw = readFileSync(join(FIXTURES, "plan-missing-one-tag.json"), "utf-8");
    const plan = parsePlanJson(raw);
    const violations = checkPlan(plan);
    const allMissing = violations.flatMap((v) => v.missingTags);
    // DataClassification is missing from the VPC resource in this fixture
    expect(allMissing).toContain("DataClassification");
  });

  it("names the resource address in the violation", () => {
    const raw = readFileSync(join(FIXTURES, "plan-missing-one-tag.json"), "utf-8");
    const plan = parsePlanJson(raw);
    const violations = checkPlan(plan);
    const addresses = violations.map((v) => v.address);
    expect(addresses.some((a) => a.includes("aws_vpc"))).toBe(true);
  });
});

describe("checkPlan — plan-non-taggable.json", () => {
  it("returns no violations when all resources are non-taggable or data sources", () => {
    const raw = readFileSync(join(FIXTURES, "plan-non-taggable.json"), "utf-8");
    const plan = parsePlanJson(raw);
    const violations = checkPlan(plan);
    expect(violations).toHaveLength(0);
  });
});

describe("checkPlan — plan-malformed.json", () => {
  it("parsePlanJson throws on malformed fixture", () => {
    const raw = readFileSync(join(FIXTURES, "plan-malformed.json"), "utf-8");
    expect(() => parsePlanJson(raw)).toThrow();
  });
});

describe("checkPlan — empty resource_changes", () => {
  it("returns no violations for a plan with no changes", () => {
    const plan: TerraformPlanJson = { format_version: "1.2", resource_changes: [] };
    expect(checkPlan(plan)).toHaveLength(0);
  });

  it("returns no violations for a plan missing resource_changes entirely", () => {
    const plan: TerraformPlanJson = { format_version: "1.2" };
    expect(checkPlan(plan)).toHaveLength(0);
  });
});
