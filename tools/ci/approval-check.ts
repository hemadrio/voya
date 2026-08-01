#!/usr/bin/env tsx
/**
 * approval-check.ts — Production promotion separation-of-duty gate (WO-087).
 *
 * Reads the approver identity from the pipeline platform (FORGE_APPROVER env
 * var, injected by the Forge runner — NOT from a user-supplied parameter) and
 * the commit author from git log, then fails if they are the same person.
 *
 * This enforces A03 separation of duty: the person who authored the commit
 * cannot be the same person who approves its promotion to production.
 *
 * Identity spoofing prevention:
 *   - FORGE_APPROVER is set by the Forge runner from the authenticated SSO
 *     identity. The pipeline YAML cannot override it.
 *   - FORGE_COMMIT_AUTHOR is populated from the git reflog annotation; it
 *     falls back to `git log -1 --format=%ae` when absent.
 *   - Both values are normalised to lowercase before comparison.
 *
 * Usage:
 *   tsx tools/ci/approval-check.ts [--commit-sha <sha>]
 *
 * Exit codes:
 *   0 — approver identity verified as different from commit author
 *   1 — self-approval rejected or identities could not be resolved
 *   2 — usage / configuration error
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExecFn = (cmd: string) => string;
export type EnvReader = (key: string) => string | undefined;

export interface ApprovalCheckResult {
  approver: string;
  commitAuthor: string;
  passed: boolean;
  reason: string;
}

export type ApprovalOutcome =
  | { ok: true; result: ApprovalCheckResult }
  | { ok: false; error: { code: "SELF_APPROVAL" | "MISSING_IDENTITY" | "GIT_ERROR"; message: string }; result: ApprovalCheckResult };

export interface ApprovalAuditRecord {
  event: "deploy.approval_check";
  timestamp: string;
  approver: string;
  commitAuthor: string;
  commitSha: string;
  passed: boolean;
  reason: string;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Default command executor.
 */
export function defaultExec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

/**
 * Default environment reader.
 */
export function defaultEnvReader(key: string): string | undefined {
  return process.env[key];
}

/**
 * Normalise an identity string for comparison:
 *   - Lowercase
 *   - Trim surrounding whitespace
 *   - Strip mail angle-bracket wrapping: "Name <email>" → "email"
 */
export function normaliseIdentity(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const match = /<([^>]+)>/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

/**
 * Read the commit author email for a given SHA using the injected executor.
 */
export function readCommitAuthor(sha: string, exec: ExecFn): string {
  return exec(`git log -1 --format=%ae ${sha}`);
}

/**
 * Run the approval identity check.
 *
 * @param commitSha   The commit SHA being promoted (defaults to HEAD).
 * @param exec        Command executor (injectable for tests).
 * @param env         Environment reader (injectable for tests).
 */
export function checkApproval(
  commitSha: string = "HEAD",
  exec: ExecFn = defaultExec,
  env: EnvReader = defaultEnvReader
): ApprovalOutcome {
  const timestamp = new Date().toISOString();

  // Read approver from pipeline platform — NOT from user-supplied args.
  const rawApprover =
    env("FORGE_APPROVER") ??
    env("CI_APPROVER") ??
    env("GITHUB_ACTOR"); // fallback for GitHub Actions-based runners

  if (!rawApprover) {
    const result: ApprovalCheckResult = {
      approver: "unknown",
      commitAuthor: "unknown",
      passed: false,
      reason: "FORGE_APPROVER environment variable is not set. The approval identity must be injected by the pipeline platform.",
    };
    return {
      ok: false,
      error: { code: "MISSING_IDENTITY", message: result.reason },
      result,
    };
  }

  // Read commit author from git log (not from user-supplied params).
  let rawAuthor: string;
  try {
    // Try FORGE_COMMIT_AUTHOR first (set by runner from the push event payload).
    rawAuthor = env("FORGE_COMMIT_AUTHOR") ?? exec(`git log -1 --format=%ae ${commitSha}`);
  } catch (err) {
    const result: ApprovalCheckResult = {
      approver: normaliseIdentity(rawApprover),
      commitAuthor: "unknown",
      passed: false,
      reason: `Could not read commit author: ${String(err)}`,
    };
    return {
      ok: false,
      error: { code: "GIT_ERROR", message: result.reason },
      result,
    };
  }

  const approver = normaliseIdentity(rawApprover);
  const author = normaliseIdentity(rawAuthor);

  if (!approver || !author) {
    const result: ApprovalCheckResult = {
      approver,
      commitAuthor: author,
      passed: false,
      reason: "One or both identities resolved to an empty string after normalisation.",
    };
    return {
      ok: false,
      error: { code: "MISSING_IDENTITY", message: result.reason },
      result,
    };
  }

  if (approver === author) {
    const result: ApprovalCheckResult = {
      approver,
      commitAuthor: author,
      passed: false,
      reason: `Self-approval rejected: approver "${approver}" is the same as commit author "${author}". ` +
        "Production promotion requires a separate approver (A03 separation of duty).",
    };
    return {
      ok: false,
      error: { code: "SELF_APPROVAL", message: result.reason },
      result,
    };
  }

  const result: ApprovalCheckResult = {
    approver,
    commitAuthor: author,
    passed: true,
    reason: `Approval accepted: approver "${approver}" differs from commit author "${author}".`,
  };
  return { ok: true, result };
}

/**
 * Build an audit record from an approval check result.
 */
export function buildApprovalAuditRecord(
  checkResult: ApprovalCheckResult,
  commitSha: string,
  timestamp: string
): ApprovalAuditRecord {
  return {
    event: "deploy.approval_check",
    timestamp,
    approver: checkResult.approver,
    commitAuthor: checkResult.commitAuthor,
    commitSha,
    passed: checkResult.passed,
    reason: checkResult.reason,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let commitSha = "HEAD";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--commit-sha" && args[i + 1]) commitSha = args[++i] as string;
  }

  const timestamp = new Date().toISOString();
  const outcome = checkApproval(commitSha);
  const audit = buildApprovalAuditRecord(outcome.result, commitSha, timestamp);

  // Always emit the audit record — passed or failed.
  console.log(`[approval-check] AUDIT: ${JSON.stringify(audit)}`);

  if (!outcome.ok) {
    console.error(`[approval-check] REJECTED (${outcome.error.code}): ${outcome.error.message}`);
    process.exit(1);
  }

  console.log(`[approval-check] APPROVED: ${outcome.result.reason}`);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith("approval-check.ts") ||
  process.argv[1]?.endsWith("approval-check.js")
) {
  main().catch((err) => {
    console.error("[approval-check] Fatal:", err);
    process.exit(2);
  });
}
