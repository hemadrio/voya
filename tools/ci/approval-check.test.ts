/**
 * Unit tests for approval-check.ts — WO-087.
 *
 * Covers:
 *   - normaliseIdentity: plain email, angle-bracket form, mixed case
 *   - checkApproval: happy path (different identities), self-approval rejection,
 *     missing FORGE_APPROVER, git error, empty identity after normalisation
 *   - buildApprovalAuditRecord: structure validation
 *   - Fixture files: valid-approval.json, self-approval.json
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  normaliseIdentity,
  checkApproval,
  buildApprovalAuditRecord,
  type ExecFn,
  type EnvReader,
} from "./approval-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv(vars: Record<string, string | undefined>): EnvReader {
  return (key: string) => vars[key];
}

function makeExec(email: string): ExecFn {
  return () => email;
}

// ── normaliseIdentity ─────────────────────────────────────────────────────────

describe("normaliseIdentity", () => {
  it("lowercases a plain email", () => {
    expect(normaliseIdentity("ALICE@EXAMPLE.COM")).toBe("alice@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseIdentity("  bob@example.com  ")).toBe("bob@example.com");
  });

  it("extracts email from angle-bracket form", () => {
    expect(normaliseIdentity("Alice Smith <alice@example.com>")).toBe("alice@example.com");
  });

  it("lowercases extracted email", () => {
    expect(normaliseIdentity("Bob Smith <BOB@EXAMPLE.COM>")).toBe("bob@example.com");
  });

  it("returns empty string for empty input", () => {
    expect(normaliseIdentity("")).toBe("");
  });

  it("handles angle-brackets with no display name", () => {
    expect(normaliseIdentity("<carol@example.com>")).toBe("carol@example.com");
  });
});

// ── checkApproval — happy path ────────────────────────────────────────────────

describe("checkApproval — happy path", () => {
  it("passes when approver differs from commit author", () => {
    const env = makeEnv({ FORGE_APPROVER: "approver@example.com" });
    const exec = makeExec("author@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.passed).toBe(true);
    expect(outcome.result.approver).toBe("approver@example.com");
    expect(outcome.result.commitAuthor).toBe("author@example.com");
  });

  it("normalises both identities before comparing", () => {
    const env = makeEnv({ FORGE_APPROVER: "APPROVER@EXAMPLE.COM" });
    const exec = makeExec("AUTHOR@EXAMPLE.COM");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.approver).toBe("approver@example.com");
    expect(outcome.result.commitAuthor).toBe("author@example.com");
  });

  it("accepts angle-bracket form in FORGE_APPROVER", () => {
    const env = makeEnv({ FORGE_APPROVER: "Charlie Brown <charlie@example.com>" });
    const exec = makeExec("author@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.approver).toBe("charlie@example.com");
  });

  it("uses FORGE_COMMIT_AUTHOR env var when set, skipping git log", () => {
    let gitCalled = false;
    const env = makeEnv({
      FORGE_APPROVER: "approver@example.com",
      FORGE_COMMIT_AUTHOR: "envauthor@example.com",
    });
    const exec: ExecFn = () => { gitCalled = true; return "git@example.com"; };
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
    expect(gitCalled).toBe(false);
    if (!outcome.ok) return;
    expect(outcome.result.commitAuthor).toBe("envauthor@example.com");
  });

  it("falls back to CI_APPROVER when FORGE_APPROVER absent", () => {
    const env = makeEnv({ CI_APPROVER: "ci-approver@example.com" });
    const exec = makeExec("author@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.approver).toBe("ci-approver@example.com");
  });
});

// ── checkApproval — self-approval rejection ───────────────────────────────────

describe("checkApproval — self-approval rejection (AC2)", () => {
  it("rejects self-approval: same email", () => {
    const env = makeEnv({ FORGE_APPROVER: "alice@example.com" });
    const exec = makeExec("alice@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SELF_APPROVAL");
    expect(outcome.result.passed).toBe(false);
  });

  it("rejects self-approval: same email with different case", () => {
    const env = makeEnv({ FORGE_APPROVER: "ALICE@EXAMPLE.COM" });
    const exec = makeExec("alice@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SELF_APPROVAL");
  });

  it("rejects self-approval: approver in angle-bracket form, author plain", () => {
    const env = makeEnv({ FORGE_APPROVER: "Alice Smith <alice@example.com>" });
    const exec = makeExec("alice@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SELF_APPROVAL");
  });

  it("uses fixture self-approval.json for reference", () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, "approval-self-approval.json"), "utf-8")
    ) as { approver: string; commitAuthor: string };
    const env = makeEnv({ FORGE_APPROVER: fixture.approver });
    const exec = makeExec(fixture.commitAuthor);
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("SELF_APPROVAL");
  });
});

// ── checkApproval — missing identity ─────────────────────────────────────────

describe("checkApproval — missing identity", () => {
  it("returns MISSING_IDENTITY when FORGE_APPROVER is not set", () => {
    const env = makeEnv({});
    const exec = makeExec("author@example.com");
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("MISSING_IDENTITY");
  });

  it("returns GIT_ERROR when git log throws", () => {
    const env = makeEnv({ FORGE_APPROVER: "approver@example.com" });
    const exec: ExecFn = () => { throw new Error("fatal: bad revision"); };
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("GIT_ERROR");
  });
});

// ── buildApprovalAuditRecord ──────────────────────────────────────────────────

describe("buildApprovalAuditRecord", () => {
  it("sets event to deploy.approval_check", () => {
    const record = buildApprovalAuditRecord(
      { approver: "a@b.com", commitAuthor: "c@d.com", passed: true, reason: "ok" },
      "abc1234",
      "2024-01-01T12:00:00Z"
    );
    expect(record.event).toBe("deploy.approval_check");
    expect(record.passed).toBe(true);
    expect(record.commitSha).toBe("abc1234");
  });

  it("captures rejection in audit record", () => {
    const record = buildApprovalAuditRecord(
      {
        approver: "alice@example.com",
        commitAuthor: "alice@example.com",
        passed: false,
        reason: "Self-approval rejected",
      },
      "abc1234",
      "2024-01-01T12:00:00Z"
    );
    expect(record.passed).toBe(false);
    expect(record.reason).toMatch(/self-approval/i);
  });
});

// ── valid-approval fixture ────────────────────────────────────────────────────

describe("checkApproval — valid-approval.json fixture", () => {
  it("passes with different approver and author from fixture", () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, "approval-valid.json"), "utf-8")
    ) as { approver: string; commitAuthor: string };
    const env = makeEnv({ FORGE_APPROVER: fixture.approver });
    const exec = makeExec(fixture.commitAuthor);
    const outcome = checkApproval("abc1234", exec, env);
    expect(outcome.ok).toBe(true);
  });
});
