#!/usr/bin/env tsx
/**
 * affected.ts — Turborepo affected-graph filter resolver (WO-084).
 *
 * Determines which packages are affected by changes relative to a git baseline
 * and emits the correct `--filter` argument for `turbo run`.
 *
 * Rules:
 *  1. If root-config files changed (tsconfig.base.json, turbo.json,
 *     pnpm-workspace.yaml, pnpm-lock.yaml) → full build (filter "...").
 *  2. If the baseline ref cannot be resolved (shallow clone, first PR run,
 *     no remote) → full build (filter "...").
 *  3. Otherwise → affected graph filter "...[<base>]".
 *
 * Usage:
 *   tsx tools/ci/affected.ts [--base <ref>] [--output filter|json]
 *
 * Options:
 *   --base <ref>   Git ref to diff against (default: origin/main)
 *   --output       "filter" prints the --filter= value (default)
 *                  "json"   prints JSON object with { filter, reason, full }
 *
 * Exit codes:
 *   0 — filter resolved and printed
 *   2 — usage error
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExecFn = (cmd: string) => string;

export interface AffectedResult {
  /** The --filter= value to pass to turbo. */
  filter: string;
  /** Whether this is a full-rebuild (true) or scoped-affected (false). */
  full: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Which root-config files triggered a full rebuild (empty unless full=true). */
  rootConfigChanged: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Root-config files whose change invalidates all Turborepo task caches.
 * A commit touching any of these triggers a full rebuild.
 */
export const ROOT_CONFIG_FILES: readonly string[] = [
  "tsconfig.base.json",
  "turbo.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
];

/** Default git baseline ref. */
export const DEFAULT_BASE = "origin/main";

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Default executor: wraps execSync and trims stdout.
 * Throws on non-zero exit.
 */
export function defaultExec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

/**
 * Check whether the baseline ref is reachable from HEAD.
 * Returns false on any error (shallow clone, no remote, divergent history).
 */
export function isBaselineReachable(base: string, exec: ExecFn): boolean {
  try {
    exec(`git rev-parse --verify ${base}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files changed between HEAD and the baseline ref.
 * Returns an empty array on error (treated as unknown change set).
 */
export function listChangedFiles(base: string, exec: ExecFn): string[] {
  try {
    const output = exec(`git diff --name-only ${base}...HEAD`);
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Determine which root-config files appear in the changed file list.
 */
export function findRootConfigChanges(changedFiles: string[]): string[] {
  const changed = new Set(changedFiles);
  return ROOT_CONFIG_FILES.filter((f) => changed.has(f));
}

/**
 * Resolve the Turborepo --filter= argument for the current workspace state.
 *
 * @param opts.base  Git ref to diff against (default: origin/main).
 * @param opts.exec  Command executor (default: execSync wrapper — override in tests).
 */
export function resolveAffectedFilter(
  opts: {
    base?: string;
    exec?: ExecFn;
  } = {}
): AffectedResult {
  const base = opts.base ?? DEFAULT_BASE;
  const exec = opts.exec ?? defaultExec;

  // Rule 2: baseline unreachable → full build.
  if (!isBaselineReachable(base, exec)) {
    return {
      filter: "...",
      full: true,
      reason: `Baseline ref ${JSON.stringify(base)} is not reachable — falling back to full build. This is expected on the first run of a new branch or in shallow clones.`,
      rootConfigChanged: [],
    };
  }

  const changedFiles = listChangedFiles(base, exec);

  // Rule 1: root-config change → full build.
  const rootConfigChanged = findRootConfigChanges(changedFiles);
  if (rootConfigChanged.length > 0) {
    return {
      filter: "...",
      full: true,
      reason: `Root-config file(s) changed — full rebuild required to invalidate all caches: ${rootConfigChanged.join(", ")}`,
      rootConfigChanged,
    };
  }

  // Rule 3: normal affected-graph filter.
  return {
    filter: `...[${base}]`,
    full: false,
    reason: `Affected-graph filter against ${JSON.stringify(base)}.`,
    rootConfigChanged: [],
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let base = DEFAULT_BASE;
  let outputMode: "filter" | "json" = "filter";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && args[i + 1]) {
      base = args[++i] as string;
    } else if (args[i] === "--output" && args[i + 1]) {
      const mode = args[++i];
      if (mode !== "filter" && mode !== "json") {
        console.error(`[affected] ERROR: --output must be "filter" or "json", got ${JSON.stringify(mode)}`);
        process.exit(2);
      }
      outputMode = mode;
    }
  }

  const result = resolveAffectedFilter({ base });

  if (outputMode === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.filter);
  }

  process.exit(0);
}

if (
  process.argv[1]?.endsWith("affected.ts") ||
  process.argv[1]?.endsWith("affected.js")
) {
  main().catch((err) => {
    console.error("[affected] Fatal:", err);
    process.exit(2);
  });
}
