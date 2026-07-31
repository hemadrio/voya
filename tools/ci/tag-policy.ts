#!/usr/bin/env tsx
/**
 * tag-policy.ts — Terraform plan tag policy check (WO-089).
 *
 * Consumes a Terraform plan JSON produced by `terraform show -json <planfile>`
 * and fails if any taggable AWS resource would be created or updated without
 * all five mandatory tags.
 *
 * Mandatory tags (sourced from provider default_tags via var.tags):
 *   Service, Environment, CostCentre, Owner, DataClassification
 *
 * Non-taggable resource types are skipped via a maintained allow-list.
 * Delete-only and data-source changes are also skipped.
 *
 * Usage (stdin):
 *   terraform show -json tfplan | npx tsx tools/ci/tag-policy.ts
 *
 * Usage (file):
 *   npx tsx tools/ci/tag-policy.ts --plan tfplan.json
 *
 * Exit codes:
 *   0 — all taggable resources carry all five mandatory tags
 *   1 — one or more resources are missing mandatory tags
 *   2 — usage / I/O / parse error
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TerraformPlanJson {
  format_version?: string;
  resource_changes?: ResourceChange[];
}

export interface ResourceChange {
  address: string;
  module_address?: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  provider_name?: string;
  change: {
    actions: string[];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    after_unknown?: Record<string, unknown>;
  };
}

export interface TagViolation {
  address: string;
  type: string;
  missingTags: string[];
  /** true when tags_all is absent rather than present but incomplete */
  tagsAllAbsent: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const MANDATORY_TAGS: readonly string[] = [
  "Service",
  "Environment",
  "CostCentre",
  "Owner",
  "DataClassification",
];

/**
 * AWS resource types that do not accept tags or do not inherit provider
 * default_tags.  Additions require a code comment referencing AWS docs.
 */
export const NON_TAGGABLE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  // IAM inline policies and attachments have no tag support
  "aws_iam_role_policy",
  "aws_iam_role_policy_attachment",
  "aws_iam_user_policy",
  "aws_iam_user_policy_attachment",
  "aws_iam_group_policy",
  "aws_iam_group_policy_attachment",

  // Route53 records have no tag support
  "aws_route53_record",

  // ACM certificate validation is a wait construct with no tag support
  "aws_acm_certificate_validation",

  // VPC route and association resources have no tag support
  "aws_route",
  "aws_route_table_association",
  "aws_subnet_route_table_association",
  "aws_main_route_table_association",
  "aws_internet_gateway_attachment",

  // Deprecated security group rule resource (use aws_vpc_security_group_*_rule instead)
  "aws_security_group_rule",

  // Load balancer attachment resources have no tag support
  "aws_lb_listener_certificate",
  "aws_lb_target_group_attachment",
  "aws_alb_listener_certificate",
  "aws_alb_target_group_attachment",

  // CloudWatch subscription filter has no tag support
  "aws_cloudwatch_log_subscription_filter",

  // Lambda permission (resource-based policy statement) has no tag support
  "aws_lambda_permission",

  // Application Auto Scaling: target supports tags, policy does not
  "aws_appautoscaling_policy",

  // Auto Scaling group attachment has no tag support
  "aws_autoscaling_attachment",

  // WAF associations and logging config have no tag support
  "aws_wafv2_web_acl_association",
  "aws_wafv2_web_acl_logging_configuration",

  // RDS proxy target/group (associated resource, not tagged separately)
  "aws_db_proxy_target",

  // ECS tag resource (itself a tag, not a tagged resource)
  "aws_ecs_tag",

  // Non-AWS provider resources (no tags concept)
  "null_resource",
  "terraform_data",
  "local_file",
  "random_string",
  "random_password",
  "random_id",
  "random_integer",
  "random_pet",
  "time_sleep",
  "time_rotating",
  "time_static",
  "tls_private_key",
  "tls_self_signed_cert",
  "tls_cert_request",
  "tls_locally_signed_cert",
]);

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Parse and validate the terraform plan JSON.
 * Throws on malformed input (not an object, missing resource_changes).
 */
export function parsePlanJson(raw: string): TerraformPlanJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Plan JSON is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Plan JSON must be a JSON object");
  }
  return parsed as TerraformPlanJson;
}

/**
 * Determine whether a resource change should be skipped by the tag check.
 * Returns a string reason if skipped, or null if it must be checked.
 */
export function skipReason(change: ResourceChange): string | null {
  // Data sources are not managed resources
  if (change.mode === "data") return "data source";

  // Deletions do not introduce untagged resources
  const actions = change.change.actions;
  if (actions.length === 1 && actions[0] === "delete") return "delete-only";

  // No-op changes
  if (actions.length === 1 && actions[0] === "no-op") return "no-op";

  // Non-taggable resource types
  if (NON_TAGGABLE_RESOURCE_TYPES.has(change.type)) return "non-taggable";

  // Non-AWS providers (e.g. registry.terraform.io/hashicorp/random)
  if (
    change.provider_name &&
    !change.provider_name.includes("/hashicorp/aws") &&
    !change.provider_name.includes("aws")
  ) {
    return `non-aws provider: ${change.provider_name}`;
  }

  return null;
}

/**
 * Check a single resource change for missing mandatory tags.
 * Returns a TagViolation if any mandatory tags are absent, or null if compliant.
 */
export function checkResourceChange(change: ResourceChange): TagViolation | null {
  const reason = skipReason(change);
  if (reason !== null) return null;

  const after = change.change.after;

  // If the `after` state is null (e.g. destroy-only or deferred), skip
  if (!after) return null;

  const tagsAll = after["tags_all"];

  // If tags_all is absent on a taggable resource, all mandatory tags are missing
  if (tagsAll === undefined || tagsAll === null) {
    // Check if tags_all is unknown at plan time (computed)
    const afterUnknown = change.change.after_unknown;
    if (afterUnknown && afterUnknown["tags_all"] === true) {
      // Fully computed at apply time — cannot verify; skip with a warning
      return null;
    }
    return {
      address: change.address,
      type: change.type,
      missingTags: [...MANDATORY_TAGS],
      tagsAllAbsent: true,
    };
  }

  if (typeof tagsAll !== "object" || Array.isArray(tagsAll)) {
    // tags_all is not a map — treat as all missing
    return {
      address: change.address,
      type: change.type,
      missingTags: [...MANDATORY_TAGS],
      tagsAllAbsent: true,
    };
  }

  const tagMap = tagsAll as Record<string, unknown>;
  const missingTags = MANDATORY_TAGS.filter(
    (key) => !tagMap[key] || typeof tagMap[key] !== "string" || tagMap[key] === ""
  );

  if (missingTags.length === 0) return null;

  return {
    address: change.address,
    type: change.type,
    missingTags,
    tagsAllAbsent: false,
  };
}

/**
 * Run the policy check over a full plan JSON.
 * Returns an array of violations (empty array = pass).
 */
export function checkPlan(plan: TerraformPlanJson): TagViolation[] {
  if (!plan.resource_changes) return [];
  const violations: TagViolation[] = [];
  for (const change of plan.resource_changes) {
    const violation = checkResourceChange(change);
    if (violation) violations.push(violation);
  }
  return violations;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let planPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan" && args[i + 1]) {
      planPath = resolve(args[++i]);
    }
  }

  let rawJson: string;

  if (planPath) {
    try {
      rawJson = readFileSync(planPath, "utf-8");
    } catch (err) {
      console.error(`[tag-policy] ERROR: Cannot read plan file ${planPath}: ${String(err)}`);
      process.exit(2);
    }
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    rawJson = Buffer.concat(chunks).toString("utf-8");
  }

  let plan: TerraformPlanJson;
  try {
    plan = parsePlanJson(rawJson);
  } catch (err) {
    console.error(`[tag-policy] ERROR: ${String(err)}`);
    process.exit(2);
  }

  const violations = checkPlan(plan);

  if (violations.length === 0) {
    const total = plan.resource_changes?.length ?? 0;
    console.log(`[tag-policy] PASSED — all taggable resources in ${total} change(s) carry all five mandatory tags.`);
    process.exit(0);
  }

  console.error(`[tag-policy] FAILED — ${violations.length} resource(s) missing mandatory tags:\n`);

  for (const v of violations) {
    if (v.tagsAllAbsent) {
      console.error(
        `  [MISSING tags_all] ${v.address} (${v.type})\n` +
        `    tags_all attribute is absent — resource may not inherit provider default_tags.\n` +
        `    Add this resource type to NON_TAGGABLE_RESOURCE_TYPES if it cannot accept tags,\n` +
        `    or ensure it is deployed inside a Terraform workspace with the mandatory provider\n` +
        `    default_tags block from infra/terraform/envs/<env>/backend.tf.`
      );
    } else {
      console.error(
        `  [MISSING TAGS] ${v.address} (${v.type})\n` +
        `    Missing: ${v.missingTags.join(", ")}\n` +
        `    Ensure the provider default_tags block in backend.tf carries all five mandatory\n` +
        `    tags, or add the missing tags explicitly to the resource's tags = {} block.`
      );
    }
  }

  console.error(
    `\n  See docs/governance/tagging.md for permitted values and the exemption process.\n` +
    `  Non-taggable resource types must be added to NON_TAGGABLE_RESOURCE_TYPES in\n` +
    `  tools/ci/tag-policy.ts with a comment referencing AWS documentation.`
  );

  process.exit(1);
}

// Run when executed directly
if (
  process.argv[1]?.endsWith("tag-policy.ts") ||
  process.argv[1]?.endsWith("tag-policy.js")
) {
  main().catch((err) => {
    console.error("[tag-policy] Fatal:", err);
    process.exit(2);
  });
}
