#!/usr/bin/env tsx
/**
 * artifact-guard.ts — NPM Build policy check (WO-085).
 *
 * Scans the current git commit diff for packaged artefacts and sensitive files
 * that must never be committed:
 *
 *   *.tgz             — packaged npm artefacts
 *   node_modules/     — vendored dependencies
 *   .env*             — environment variable files (any suffix)
 *   *.pem             — PEM certificates / private keys
 *   *.p12 / *.pfx     — PKCS#12 key stores
 *   id_rsa / id_ecdsa / id_ed25519 — SSH private key files
 *   *.key             — generic key files
 *
 * Fails with exit code 1 and an actionable message identifying every
 * violating path when any match is found in the diff.
 *
 * Usage:
 *   node --import tsx/esm tools/ci/artifact-guard.ts [--diff <file>]
 *
 *   --diff <file>   Read diff from a file instead of running `git diff HEAD^`
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more prohibited files detected in the diff
 *   2 — usage / I/O error
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArtifactViolation {
  path: string;
  reason: string;
}

export interface GuardResult {
  passed: boolean;
  violations: ArtifactViolation[];
  diff: string;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

export interface ForbiddenPattern {
  pattern: RegExp;
  reason: string;
}

export const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    pattern: /\.tgz$/i,
    reason: "Packaged npm artefact (.tgz). Run `npm pack` locally and add to .gitignore.",
  },
  {
    pattern: /(^|\/)node_modules\//,
    reason:
      "Vendored node_modules directory. Dependencies must be installed via pnpm, not committed.",
  },
  {
    pattern: /(^|\/)\.env(\.|$)/,
    reason:
      "Environment file (.env / .env.*). Use a secrets manager or CI secrets; never commit credentials.",
  },
  {
    pattern: /\.pem$/i,
    reason:
      "PEM file. Certificates and private keys must not be committed. Use AWS ACM or Secrets Manager.",
  },
  {
    pattern: /\.(p12|pfx)$/i,
    reason: "PKCS#12 key store. Key material must not be committed.",
  },
  {
    pattern: /(^|\/)id_(rsa|ecdsa|ed25519)$/,
    reason: "SSH private key file. SSH keys must not be committed.",
  },
  {
    pattern: /\.key$/i,
    reason: "Generic key file. Key material must not be committed.",
  },
];

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Extract the set of added/modified file paths from a unified diff.
 * Only lines starting with `+++ b/` (new file header) or `diff --git a/ b/`
 * are examined — binary files show up in the diff header, not the content.
 */
export function extractAddedPaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split("\n")) {
    // Unified diff header: +++ b/<path>
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p !== "/dev/null") paths.add(p);
    }
    // Git diff header: diff --git a/<path> b/<path>
    const gitHeader = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (gitHeader) {
      paths.add(gitHeader[1].trim());
    }
    // Rename/new file: rename to <path> or new file mode ... <path>
    const renameMatch = line.match(/^rename to (.+)$/);
    if (renameMatch) paths.add(renameMatch[1].trim());
  }

  return [...paths];
}

/**
 * Scan a list of paths against the forbidden patterns.
 */
export function checkPaths(paths: string[]): ArtifactViolation[] {
  const violations: ArtifactViolation[] = [];

  for (const p of paths) {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(p)) {
        violations.push({ path: p, reason });
        break; // one message per path is enough
      }
    }
  }

  return violations;
}

/**
 * Run the full guard check against a diff string.
 */
export function runGuard(diff: string): GuardResult {
  const paths = extractAddedPaths(diff);
  const violations = checkPaths(paths);
  return { passed: violations.length === 0, violations, diff };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const diffFileIdx = args.indexOf("--diff");

  let diff: string;

  if (diffFileIdx !== -1 && args[diffFileIdx + 1]) {
    try {
      diff = readFileSync(args[diffFileIdx + 1], "utf8");
    } catch (err) {
      console.error(`[artifact-guard] ERROR: Cannot read diff file: ${args[diffFileIdx + 1]}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  } else {
    try {
      // On main: diff against the previous commit.
      // On a PR: FORGE_BASE_SHA is set by the runner; fall back to HEAD^.
      const base = process.env["FORGE_BASE_SHA"] ?? "HEAD^";
      diff = execSync(`git diff ${base} HEAD --name-only --diff-filter=ACMR`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      // name-only output — convert to a minimal "diff" format the parser understands
      diff = diff
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => `+++ b/${p}`)
        .join("\n");
    } catch (err) {
      console.error("[artifact-guard] ERROR: git diff failed");
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  }

  const result = runGuard(diff);

  if (result.passed) {
    console.log("[artifact-guard] PASS — no prohibited files detected.");
    process.exit(0);
  }

  console.error("[artifact-guard] FAIL — prohibited files detected in commit diff:");
  console.error("");
  for (const v of result.violations) {
    console.error(`  ✗  ${v.path}`);
    console.error(`     ${v.reason}`);
    console.error("");
  }
  console.error(
    `${result.violations.length} violation(s) found. Remove the file(s) from the commit and re-push.`,
  );
  process.exit(1);
}

main();
