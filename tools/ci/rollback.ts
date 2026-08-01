#!/usr/bin/env tsx
/**
 * rollback.ts — ECS rolling-deploy rollback executor (WO-087).
 *
 * Resolves the previous immutable task-definition revision from the ECS
 * service deployment history, calls UpdateService to re-point the service at
 * that revision, waits for steady state, and times the full operation.
 *
 * Rules:
 *  - Rollback MUST target a previous immutable task-definition revision.
 *    Rebuilding an image to roll back is NOT acceptable.
 *  - If no previous revision exists (first deploy), the script fails with a
 *    clear diagnostic message rather than crashing or deploying an arbitrary
 *    revision.
 *  - Every rollback emits an immutable audit record: actor, timestamp,
 *    service, previous revision ARN, and new (rollback target) revision ARN.
 *
 * Usage:
 *   tsx tools/ci/rollback.ts --cluster <name> --service <name> [--region <r>] [--actor <id>]
 *
 * Exit codes:
 *   0 — rollback completed and service reached steady state
 *   1 — rollback failed (no previous revision, AWS error, timeout)
 *   2 — usage error
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExecFn = (cmd: string) => string;

export interface EcsDeployment {
  id: string;
  status: string;
  taskDefinition: string;
  runningCount: number;
  createdAt: string;
}

export interface EcsDescribeServicesResponse {
  services: Array<{
    serviceName: string;
    clusterArn: string;
    deployments: EcsDeployment[];
    taskDefinition: string;
  }>;
}

export interface PreviousRevisionResult {
  /** Task definition ARN of the currently active revision. */
  current: string;
  /** Task definition ARN of the previous revision to roll back to. */
  previous: string;
}

export type PreviousRevisionOutcome =
  | { ok: true; result: PreviousRevisionResult }
  | { ok: false; error: { code: "NO_PREVIOUS_REVISION" | "SERVICE_NOT_FOUND" | "AWS_ERROR"; message: string } };

export interface RollbackResult {
  cluster: string;
  service: string;
  rolledBackFrom: string;
  rolledBackTo: string;
  durationMs: number;
  actor: string;
  timestamp: string;
}

export type RollbackOutcome =
  | { ok: true; result: RollbackResult }
  | { ok: false; error: { code: string; message: string } };

export interface AuditRecord {
  event: "deploy.rollback";
  actor: string;
  timestamp: string;
  cluster: string;
  service: string;
  previousRevision: string;
  newRevision: string;
  durationMs: number;
  outcome: "SUCCESS" | "FAILURE";
  errorMessage?: string;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Default executor wrapping execSync.
 */
export function defaultExec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

/**
 * Parse the output of `aws ecs describe-services` JSON.
 * Throws on malformed input.
 */
export function parseDescribeServicesOutput(raw: string): EcsDescribeServicesResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`describe-services output is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("describe-services output must be a JSON object");
  }
  return parsed as EcsDescribeServicesResponse;
}

/**
 * Resolve the previous task-definition revision from the ECS deployment history.
 *
 * ECS keeps up to 10 deployment records per service. We look for the most
 * recent deployment with status PRIMARY or ACTIVE whose task-definition differs
 * from the current active one — that is the previous immutable revision.
 *
 * When no previous revision exists (first deploy to the service), returns an
 * error rather than a fallback, because rolling back to an arbitrary revision
 * is unsafe.
 */
export function resolvePreviousRevision(
  raw: string
): PreviousRevisionOutcome {
  let response: EcsDescribeServicesResponse;
  try {
    response = parseDescribeServicesOutput(raw);
  } catch (err) {
    return {
      ok: false,
      error: { code: "AWS_ERROR", message: String(err) },
    };
  }

  const service = response.services?.[0];
  if (!service) {
    return {
      ok: false,
      error: {
        code: "SERVICE_NOT_FOUND",
        message: "describe-services returned no services — check cluster and service name.",
      },
    };
  }

  const current = service.taskDefinition;
  const deployments = service.deployments ?? [];

  // Find the most recent deployment whose task definition differs from current.
  // Deployments are listed most-recent first by the AWS API.
  const previous = deployments.find((d) => d.taskDefinition !== current);

  if (!previous) {
    return {
      ok: false,
      error: {
        code: "NO_PREVIOUS_REVISION",
        message:
          `Service "${service.serviceName}" has no previous task-definition revision in its ` +
          "deployment history. This is expected on a first deploy. There is nothing to roll back to.",
      },
    };
  }

  return {
    ok: true,
    result: {
      current,
      previous: previous.taskDefinition,
    },
  };
}

/**
 * Build an immutable audit record for a rollback action.
 */
export function buildAuditRecord(
  params: Omit<AuditRecord, "event">
): AuditRecord {
  return { event: "deploy.rollback", ...params };
}

/**
 * Execute a rollback: resolve previous revision, update service, wait for
 * steady state, time the operation end-to-end.
 *
 * @param cluster   ECS cluster name
 * @param service   ECS service name
 * @param region    AWS region
 * @param actor     Pipeline identity performing the rollback
 * @param exec      Command executor (injectable for tests)
 * @param getNow    Timestamp source (injectable for tests)
 */
export function executeRollback(
  cluster: string,
  service: string,
  region: string,
  actor: string,
  exec: ExecFn = defaultExec,
  getNow: () => number = () => Date.now()
): RollbackOutcome {
  const startMs = getNow();
  const timestamp = new Date(startMs).toISOString();

  // Step 1: Describe the service to get deployment history.
  let describeOutput: string;
  try {
    describeOutput = exec(
      `aws ecs describe-services --cluster ${cluster} --services ${service} --region ${region} --output json`
    );
  } catch (err) {
    return {
      ok: false,
      error: { code: "AWS_ERROR", message: `describe-services failed: ${String(err)}` },
    };
  }

  // Step 2: Resolve the previous revision.
  const resolved = resolvePreviousRevision(describeOutput);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.error.code, message: resolved.error.message } };
  }

  const { current, previous } = resolved.result;

  // Step 3: Update service to the previous revision.
  try {
    exec(
      `aws ecs update-service --cluster ${cluster} --service ${service} ` +
      `--task-definition ${previous} --region ${region} --output json`
    );
  } catch (err) {
    return {
      ok: false,
      error: { code: "AWS_ERROR", message: `update-service failed: ${String(err)}` },
    };
  }

  // Step 4: Wait for steady state (up to 10 min; circuit-breaker target is <5 min).
  try {
    exec(
      `aws ecs wait services-stable --cluster ${cluster} --services ${service} --region ${region}`
    );
  } catch (err) {
    return {
      ok: false,
      error: { code: "AWS_ERROR", message: `wait services-stable failed: ${String(err)}` },
    };
  }

  const durationMs = getNow() - startMs;

  return {
    ok: true,
    result: {
      cluster,
      service,
      rolledBackFrom: current,
      rolledBackTo: previous,
      durationMs,
      actor,
      timestamp,
    },
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let cluster: string | undefined;
  let service: string | undefined;
  let region = process.env["AWS_DEFAULT_REGION"] ?? "eu-west-1";
  // Actor must be read from the pipeline platform, not from a user-supplied param.
  // FORGE_ACTOR is injected by the Forge runner and cannot be overridden by the pipeline YAML.
  const actor = process.env["FORGE_ACTOR"] ?? process.env["CI_ACTOR"] ?? "unknown";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cluster" && args[i + 1]) cluster = args[++i];
    else if (args[i] === "--service" && args[i + 1]) service = args[++i];
    else if (args[i] === "--region" && args[i + 1]) region = args[++i];
  }

  if (!cluster || !service) {
    console.error("[rollback] ERROR: --cluster and --service are required");
    process.exit(2);
  }

  console.log(`[rollback] Starting rollback: cluster=${cluster} service=${service} actor=${actor}`);

  const outcome = executeRollback(cluster, service, region, actor);

  if (!outcome.ok) {
    const audit: AuditRecord = buildAuditRecord({
      actor,
      timestamp: new Date().toISOString(),
      cluster,
      service,
      previousRevision: "unknown",
      newRevision: "unknown",
      durationMs: 0,
      outcome: "FAILURE",
      errorMessage: outcome.error.message,
    });
    console.log(`[rollback] AUDIT: ${JSON.stringify(audit)}`);
    console.error(`[rollback] FAILED (${outcome.error.code}): ${outcome.error.message}`);
    process.exit(1);
  }

  const { result } = outcome;
  const audit: AuditRecord = buildAuditRecord({
    actor: result.actor,
    timestamp: result.timestamp,
    cluster: result.cluster,
    service: result.service,
    previousRevision: result.rolledBackFrom,
    newRevision: result.rolledBackTo,
    durationMs: result.durationMs,
    outcome: "SUCCESS",
  });

  console.log(`[rollback] AUDIT: ${JSON.stringify(audit)}`);
  console.log(
    `[rollback] SUCCESS — rolled back ${service} from ${result.rolledBackFrom} ` +
    `to ${result.rolledBackTo} in ${Math.round(result.durationMs / 1000)}s`
  );

  if (result.durationMs > 5 * 60 * 1000) {
    console.warn(`[rollback] WARN: rollback took ${Math.round(result.durationMs / 1000)}s — ` +
      "exceeds the 5-minute SLO. Review health-check grace period and autoscaling headroom.");
  }

  process.exit(0);
}

if (
  process.argv[1]?.endsWith("rollback.ts") ||
  process.argv[1]?.endsWith("rollback.js")
) {
  main().catch((err) => {
    console.error("[rollback] Fatal:", err);
    process.exit(2);
  });
}
