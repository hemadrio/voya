/**
 * Unit tests for rollback.ts — WO-087.
 *
 * Covers:
 *   - parseDescribeServicesOutput: valid JSON, invalid JSON
 *   - resolvePreviousRevision: normal history, no previous revision (first deploy),
 *     service not found, AWS error
 *   - executeRollback: happy path, no previous revision, describe-services failure,
 *     update-service failure, wait failure
 *   - buildAuditRecord: structure validation
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  parseDescribeServicesOutput,
  resolvePreviousRevision,
  executeRollback,
  buildAuditRecord,
  type EcsDescribeServicesResponse,
  type ExecFn,
} from "./rollback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDescribeOutput(
  currentTaskDef: string,
  previousTaskDef: string | null
): string {
  const deployments = previousTaskDef
    ? [
        { id: "ecs-svc-new", status: "PRIMARY", taskDefinition: currentTaskDef, runningCount: 2, createdAt: "2024-01-02T10:00:00Z" },
        { id: "ecs-svc-old", status: "ACTIVE", taskDefinition: previousTaskDef, runningCount: 0, createdAt: "2024-01-01T10:00:00Z" },
      ]
    : [
        { id: "ecs-svc-new", status: "PRIMARY", taskDefinition: currentTaskDef, runningCount: 2, createdAt: "2024-01-01T10:00:00Z" },
      ];

  const response: EcsDescribeServicesResponse = {
    services: [
      {
        serviceName: "production-auth-service",
        clusterArn: "arn:aws:ecs:eu-west-1:123456789012:cluster/production-travel-platform",
        taskDefinition: currentTaskDef,
        deployments,
      },
    ],
  };
  return JSON.stringify(response);
}

function makeExecMap(map: Record<string, string>): ExecFn {
  return (cmd: string) => {
    for (const [prefix, result] of Object.entries(map)) {
      if (cmd.startsWith(prefix)) return result;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
}

const TASK_DEF_CURRENT = "arn:aws:ecs:eu-west-1:123456789012:task-definition/production-auth-service:42";
const TASK_DEF_PREVIOUS = "arn:aws:ecs:eu-west-1:123456789012:task-definition/production-auth-service:41";

// ── parseDescribeServicesOutput ───────────────────────────────────────────────

describe("parseDescribeServicesOutput", () => {
  it("parses valid JSON", () => {
    const output = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    const result = parseDescribeServicesOutput(output);
    expect(result.services).toHaveLength(1);
    expect(result.services[0]?.taskDefinition).toBe(TASK_DEF_CURRENT);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseDescribeServicesOutput("{ not valid")).toThrow(/not valid JSON/i);
  });

  it("throws on a JSON array", () => {
    expect(() => parseDescribeServicesOutput("[]")).toThrow(/must be a JSON object/i);
  });
});

// ── resolvePreviousRevision ───────────────────────────────────────────────────

describe("resolvePreviousRevision — happy path", () => {
  it("resolves previous revision from deployment history", () => {
    const raw = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    const outcome = resolvePreviousRevision(raw);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.current).toBe(TASK_DEF_CURRENT);
    expect(outcome.result.previous).toBe(TASK_DEF_PREVIOUS);
  });

  it("uses fixture rollback-deployment-history.json", () => {
    const raw = readFileSync(join(FIXTURES, "rollback-deployment-history.json"), "utf-8");
    const outcome = resolvePreviousRevision(raw);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.previous).not.toBe(outcome.result.current);
  });
});

describe("resolvePreviousRevision — no previous revision (first deploy)", () => {
  it("returns NO_PREVIOUS_REVISION when history has only one deployment", () => {
    const raw = makeDescribeOutput(TASK_DEF_CURRENT, null);
    const outcome = resolvePreviousRevision(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("NO_PREVIOUS_REVISION");
    expect(outcome.error.message).toMatch(/first deploy/i);
  });

  it("uses fixture rollback-no-previous-revision.json", () => {
    const raw = readFileSync(join(FIXTURES, "rollback-no-previous-revision.json"), "utf-8");
    const outcome = resolvePreviousRevision(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("NO_PREVIOUS_REVISION");
  });
});

describe("resolvePreviousRevision — edge cases", () => {
  it("returns SERVICE_NOT_FOUND when services array is empty", () => {
    const raw = JSON.stringify({ services: [] });
    const outcome = resolvePreviousRevision(raw);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SERVICE_NOT_FOUND");
  });

  it("returns AWS_ERROR on invalid JSON", () => {
    const outcome = resolvePreviousRevision("{ invalid");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("AWS_ERROR");
  });
});

// ── executeRollback ───────────────────────────────────────────────────────────

describe("executeRollback — happy path", () => {
  it("returns success with timing output", () => {
    const describeOutput = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    let timeMs = 1_000_000; // start
    const exec = makeExecMap({
      "aws ecs describe-services": describeOutput,
      "aws ecs update-service": '{"service":{"serviceName":"production-auth-service"}}',
      "aws ecs wait services-stable": "",
    });

    const outcome = executeRollback(
      "production-travel-platform",
      "production-auth-service",
      "eu-west-1",
      "operator@example.com",
      exec,
      () => { timeMs += 120_000; return timeMs; } // advances 2 min each call
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.rolledBackFrom).toBe(TASK_DEF_CURRENT);
    expect(outcome.result.rolledBackTo).toBe(TASK_DEF_PREVIOUS);
    expect(outcome.result.actor).toBe("operator@example.com");
    expect(outcome.result.durationMs).toBeGreaterThan(0);
  });

  it("reports cluster and service in result", () => {
    const describeOutput = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    const exec = makeExecMap({
      "aws ecs describe-services": describeOutput,
      "aws ecs update-service": "{}",
      "aws ecs wait services-stable": "",
    });

    const outcome = executeRollback("my-cluster", "my-service", "eu-west-1", "actor", exec);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.cluster).toBe("my-cluster");
    expect(outcome.result.service).toBe("my-service");
  });
});

describe("executeRollback — no previous revision", () => {
  it("returns NO_PREVIOUS_REVISION error without calling update-service", () => {
    let updateCalled = false;
    const describeOutput = makeDescribeOutput(TASK_DEF_CURRENT, null);
    const exec = (cmd: string): string => {
      if (cmd.startsWith("aws ecs describe-services")) return describeOutput;
      if (cmd.startsWith("aws ecs update-service")) { updateCalled = true; return "{}"; }
      if (cmd.startsWith("aws ecs wait")) return "";
      throw new Error(`Unexpected: ${cmd}`);
    };

    const outcome = executeRollback("cluster", "svc", "eu-west-1", "actor", exec);
    expect(outcome.ok).toBe(false);
    expect(updateCalled).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("NO_PREVIOUS_REVISION");
  });
});

describe("executeRollback — AWS errors", () => {
  it("returns AWS_ERROR when describe-services throws", () => {
    const exec = (): string => { throw new Error("AccessDenied"); };
    const outcome = executeRollback("cluster", "svc", "eu-west-1", "actor", exec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("AWS_ERROR");
    expect(outcome.error.message).toMatch(/describe-services/i);
  });

  it("returns AWS_ERROR when update-service throws", () => {
    const describeOutput = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    const exec = (cmd: string): string => {
      if (cmd.startsWith("aws ecs describe-services")) return describeOutput;
      throw new Error("ThrottlingException");
    };
    const outcome = executeRollback("cluster", "svc", "eu-west-1", "actor", exec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("AWS_ERROR");
    expect(outcome.error.message).toMatch(/update-service/i);
  });

  it("returns AWS_ERROR when wait services-stable throws", () => {
    const describeOutput = makeDescribeOutput(TASK_DEF_CURRENT, TASK_DEF_PREVIOUS);
    const exec = (cmd: string): string => {
      if (cmd.startsWith("aws ecs describe-services")) return describeOutput;
      if (cmd.startsWith("aws ecs update-service")) return "{}";
      throw new Error("WaiterExpired");
    };
    const outcome = executeRollback("cluster", "svc", "eu-west-1", "actor", exec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("AWS_ERROR");
    expect(outcome.error.message).toMatch(/wait services-stable/i);
  });
});

// ── buildAuditRecord ──────────────────────────────────────────────────────────

describe("buildAuditRecord", () => {
  it("sets event to deploy.rollback", () => {
    const record = buildAuditRecord({
      actor: "operator@example.com",
      timestamp: "2024-01-01T12:00:00Z",
      cluster: "production-travel-platform",
      service: "production-auth-service",
      previousRevision: TASK_DEF_CURRENT,
      newRevision: TASK_DEF_PREVIOUS,
      durationMs: 90_000,
      outcome: "SUCCESS",
    });
    expect(record.event).toBe("deploy.rollback");
    expect(record.outcome).toBe("SUCCESS");
    expect(record.actor).toBe("operator@example.com");
  });

  it("includes errorMessage on failure", () => {
    const record = buildAuditRecord({
      actor: "actor",
      timestamp: "2024-01-01T12:00:00Z",
      cluster: "cluster",
      service: "svc",
      previousRevision: "unknown",
      newRevision: "unknown",
      durationMs: 0,
      outcome: "FAILURE",
      errorMessage: "NO_PREVIOUS_REVISION",
    });
    expect(record.outcome).toBe("FAILURE");
    expect(record.errorMessage).toBe("NO_PREVIOUS_REVISION");
  });
});
