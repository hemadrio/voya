#!/usr/bin/env tsx
/**
 * image-tag.ts — Immutable Docker image tag generator (WO-084).
 *
 * Produces the tag pattern: <service>-<gitsha>
 * Rejects mutable tag names (latest, stable, dev, beta, next, canary, etc.)
 * and validates the service name and SHA format.
 *
 * Usage:
 *   tsx tools/ci/image-tag.ts <service-name> [--sha <gitsha>]
 *
 * If --sha is omitted, the current git HEAD short SHA is used.
 *
 * Exit codes:
 *   0 — tag printed to stdout
 *   1 — validation error (mutable tag or invalid input)
 *   2 — usage / git error
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ImageTagResult {
  /** The full image tag in the form <service>-<sha>. */
  tag: string;
  service: string;
  sha: string;
}

export type ImageTagErrorCode =
  | "MUTABLE_TAG"
  | "INVALID_SERVICE_NAME"
  | "INVALID_SHA";

export interface ImageTagError {
  code: ImageTagErrorCode;
  message: string;
}

export type ImageTagOutcome =
  | { ok: true; result: ImageTagResult }
  | { ok: false; error: ImageTagError };

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Mutable tag names that must never be used as image tags.
 * The check is case-insensitive.
 */
export const MUTABLE_TAGS: ReadonlySet<string> = new Set([
  "latest",
  "stable",
  "dev",
  "development",
  "beta",
  "alpha",
  "next",
  "canary",
  "edge",
  "nightly",
  "snapshot",
  "master",
  "main",
  "release",
  "current",
]);

/** Lowercase alphanumeric with optional internal hyphens; no leading/trailing hyphens. */
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** 7–40 lowercase hex characters (abbreviated or full git SHA). */
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Validate a service name string.
 * Returns an error descriptor or null.
 */
export function validateServiceName(name: string): ImageTagError | null {
  if (!name || name !== name.trim()) {
    return {
      code: "INVALID_SERVICE_NAME",
      message: `Service name must be a non-empty string without surrounding whitespace: got ${JSON.stringify(name)}`,
    };
  }
  if (!SERVICE_NAME_RE.test(name)) {
    return {
      code: "INVALID_SERVICE_NAME",
      message:
        `Service name must be lowercase alphanumeric with optional internal hyphens ` +
        `(e.g. "auth-service", "booking"): got ${JSON.stringify(name)}`,
    };
  }
  return null;
}

/**
 * Validate a git SHA string.
 * Returns an error descriptor or null.
 */
export function validateSha(sha: string): ImageTagError | null {
  if (!GIT_SHA_RE.test(sha)) {
    return {
      code: "INVALID_SHA",
      message: `Git SHA must be 7–40 lowercase hex characters: got ${JSON.stringify(sha)}`,
    };
  }
  return null;
}

/**
 * Return true if the name matches a known mutable tag (case-insensitive).
 */
export function isMutableTag(name: string): boolean {
  return MUTABLE_TAGS.has(name.trim().toLowerCase());
}

/**
 * Generate an immutable image tag from a service name and git SHA.
 * Returns a discriminated union — never throws.
 */
export function generateTag(service: string, sha: string): ImageTagOutcome {
  const serviceError = validateServiceName(service);
  if (serviceError !== null) return { ok: false, error: serviceError };

  if (isMutableTag(service)) {
    return {
      ok: false,
      error: {
        code: "MUTABLE_TAG",
        message:
          `Service name ${JSON.stringify(service)} matches a reserved mutable tag name. ` +
          "Use a descriptive service identifier instead.",
      },
    };
  }

  const shaError = validateSha(sha);
  if (shaError !== null) return { ok: false, error: shaError };

  return {
    ok: true,
    result: { tag: `${service}-${sha}`, service, sha },
  };
}

/**
 * Read the short SHA of the current git HEAD.
 * Throws on git error.
 */
export function readGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch (err) {
    throw new Error(`git rev-parse --short HEAD failed: ${String(err)}`);
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.error("Usage: tsx tools/ci/image-tag.ts <service-name> [--sha <gitsha>]");
    process.exit(2);
  }

  const service = args[0] as string;
  let sha: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--sha" && args[i + 1]) {
      sha = args[++i];
    }
  }

  if (!sha) {
    try {
      sha = readGitSha();
    } catch (err) {
      console.error(`[image-tag] ERROR: ${String(err)}`);
      process.exit(2);
    }
  }

  const outcome = generateTag(service, sha);

  if (!outcome.ok) {
    console.error(`[image-tag] ERROR (${outcome.error.code}): ${outcome.error.message}`);
    process.exit(1);
  }

  console.log(outcome.result.tag);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith("image-tag.ts") ||
  process.argv[1]?.endsWith("image-tag.js")
) {
  main().catch((err) => {
    console.error("[image-tag] Fatal:", err);
    process.exit(2);
  });
}
