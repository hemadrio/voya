#!/usr/bin/env node
/**
 * Dependency-boundary assertion.
 *
 * @travel/contracts sits at the root of the Turborepo dependency graph (every
 * service and the web app resolve it), so it must stay dependency-light: Zod
 * and TypeScript only. Pulling in Express, Prisma, Stripe, the Anthropic SDK,
 * or any AWS SDK here would drag server infrastructure (or vendor lock-in)
 * into every downstream target, including the browser bundle.
 *
 * This script is also exercised as a unit test (see
 * test/dependency-boundary.test.ts) so it runs both standalone (`pnpm
 * check:deps`) and as part of `pnpm test` / CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(__dirname, "..", "package.json");

const FORBIDDEN_PACKAGES = [
  "express",
  "@prisma/client",
  "prisma",
  "stripe",
  "@anthropic-ai/sdk",
  "aws-sdk",
];

const FORBIDDEN_PATTERNS = [/^@aws-sdk\//];

export function findForbiddenDependencies(pkg) {
  const violations = [];
  const dependencySections = ["dependencies", "peerDependencies", "optionalDependencies"];

  for (const section of dependencySections) {
    const deps = pkg[section] ?? {};
    for (const depName of Object.keys(deps)) {
      const isForbidden =
        FORBIDDEN_PACKAGES.includes(depName) || FORBIDDEN_PATTERNS.some((pattern) => pattern.test(depName));
      if (isForbidden) {
        violations.push(`${section}.${depName}`);
      }
    }
  }

  return violations;
}

export function assertRuntimeDependencyIsZodOnly(pkg) {
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  const extras = runtimeDeps.filter((name) => name !== "zod");
  if (runtimeDeps.length === 0 || !runtimeDeps.includes("zod")) {
    throw new Error("@travel/contracts must declare zod as a runtime dependency.");
  }
  if (extras.length > 0) {
    throw new Error(`@travel/contracts must declare zod as its only runtime dependency; found extra: ${extras.join(", ")}`);
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const violations = findForbiddenDependencies(pkg);

  if (violations.length > 0) {
    console.error(`Forbidden dependency found in @travel/contracts manifest: ${violations.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  assertRuntimeDependencyIsZodOnly(pkg);
  console.log("Dependency boundary OK: @travel/contracts depends only on zod at runtime.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
