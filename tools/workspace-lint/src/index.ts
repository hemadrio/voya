#!/usr/bin/env tsx
/**
 * workspace-lint — validates pnpm workspace discipline.
 *
 * Checks performed on every workspace package manifest:
 *   1. Catalog drift  — a dependency listed in the workspace catalog must use
 *                       "catalog:" (or "catalog:<name>") as its version, never
 *                       a literal semver string.
 *   2. Workspace protocol — internal @travel/* dependencies must use
 *                            "workspace:*", never a registry version.
 *   3. Engines consistency — every package must declare an engines.node range
 *                            that is compatible with the root engines.node.
 *
 * Exit codes:
 *   0  — all checks passed
 *   1  — one or more violations found (see report on stdout)
 *
 * Usage:
 *   pnpm workspace:lint
 *   # or directly:
 *   tsx tools/workspace-lint/src/index.ts [--root <path>]
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  field: string;
  expected: string;
  actual: string;
  rule: "catalog-drift" | "workspace-protocol" | "engines-consistency";
}

export interface LintResult {
  violations: Violation[];
  checkedPackages: number;
}

interface PackageJson {
  name?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface WorkspaceYaml {
  packages?: string[];
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// YAML parser (minimal — avoids external dep in lint-critical path)
// ---------------------------------------------------------------------------

function parseSimpleYaml(content: string): WorkspaceYaml {
  // Delegate to dynamic import to keep the CLI fast when js-yaml isn't needed
  const result: WorkspaceYaml = { packages: [], catalog: {}, catalogs: {} };
  let currentSection = "";
  let currentCatalogName = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("packages:")) {
      currentSection = "packages";
      continue;
    }
    if (line.startsWith("catalog:")) {
      currentSection = "catalog";
      continue;
    }
    const catalogMatch = line.match(/^catalogs\.(\w+):|^  (\w+):\s*$/);
    if (catalogMatch && currentSection === "catalogs") {
      currentCatalogName = catalogMatch[1] ?? catalogMatch[2] ?? "";
      if (currentCatalogName && result.catalogs) {
        result.catalogs[currentCatalogName] = {};
      }
      continue;
    }

    if (currentSection === "packages") {
      const pkgMatch = line.match(/^\s*-\s*"?(.+?)"?\s*$/);
      if (pkgMatch?.[1]) result.packages?.push(pkgMatch[1]);
    } else if (currentSection === "catalog") {
      const kvMatch = line.match(/^\s+"?([^":]+)"?:\s*"?([^"#\n]+?)"?\s*(?:#.*)?$/);
      if (kvMatch?.[1] && kvMatch[2]) {
        (result.catalog as Record<string, string>)[kvMatch[1].trim()] = kvMatch[2].trim();
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Glob helper (Node 22+ has globSync; polyfill for 20)
// ---------------------------------------------------------------------------

function findFiles(pattern: string, cwd: string): string[] {
  // Use fs.readdirSync recursively for portability
  const results: string[] = [];
  const parts = pattern.split("/");
  function walk(dir: string, remaining: string[]): void {
    const [head, ...rest] = remaining;
    if (head === undefined) {
      results.push(dir);
      return;
    }
    if (head === "*") {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name), rest);
        }
      } catch { /* dir may not exist */ }
    } else {
      walk(path.join(dir, head), rest);
    }
  }
  walk(cwd, parts);
  return results;
}

// ---------------------------------------------------------------------------
// Core lint checks
// ---------------------------------------------------------------------------

export function checkCatalogDrift(
  manifest: PackageJson,
  filePath: string,
  catalog: Record<string, string>,
): Violation[] {
  const violations: Violation[] = [];
  const allDeps: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };

  for (const [dep, version] of Object.entries(allDeps)) {
    if (!(dep in catalog)) continue;
    if (version === "catalog:" || version.startsWith("catalog:")) continue;
    violations.push({
      file: filePath,
      field: `dependencies.${dep}`,
      expected: "catalog:",
      actual: version,
      rule: "catalog-drift",
    });
  }

  return violations;
}

export function checkWorkspaceProtocol(
  manifest: PackageJson,
  filePath: string,
): Violation[] {
  const violations: Violation[] = [];
  const allDeps: Record<string, string> = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  for (const [dep, version] of Object.entries(allDeps)) {
    if (!dep.startsWith("@travel/")) continue;
    if (version.startsWith("workspace:")) continue;
    violations.push({
      file: filePath,
      field: `dependencies.${dep}`,
      expected: "workspace:*",
      actual: version,
      rule: "workspace-protocol",
    });
  }

  return violations;
}

export function checkEnginesConsistency(
  manifest: PackageJson,
  filePath: string,
  rootNodeRange: string,
): Violation[] {
  if (!manifest.engines?.node) {
    return [
      {
        file: filePath,
        field: "engines.node",
        expected: rootNodeRange,
        actual: "(missing)",
        rule: "engines-consistency",
      },
    ];
  }

  // Accept the same string or any range that is at least as strict
  const declared = manifest.engines.node;
  const rootMajor = rootNodeRange.match(/>=\s*(\d+)/)?.[1] ?? "20";
  const declaredMajor = declared.match(/>=?\s*(\d+)/)?.[1];

  if (declaredMajor && parseInt(declaredMajor, 10) < parseInt(rootMajor, 10)) {
    return [
      {
        file: filePath,
        field: "engines.node",
        expected: `>= ${rootMajor} (root minimum)`,
        actual: declared,
        rule: "engines-consistency",
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function lint(rootDir: string): Promise<LintResult> {
  const workspaceFile = path.join(rootDir, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceFile)) {
    throw new Error(`pnpm-workspace.yaml not found at ${workspaceFile}`);
  }

  const workspaceContent = fs.readFileSync(workspaceFile, "utf8");
  const workspace = parseSimpleYaml(workspaceContent);
  const catalog = workspace.catalog ?? {};

  const rootPkgFile = path.join(rootDir, "package.json");
  const rootPkg: PackageJson = JSON.parse(fs.readFileSync(rootPkgFile, "utf8"));
  const rootNodeRange = rootPkg.engines?.node ?? ">=20.0.0 <21.0.0";

  const allViolations: Violation[] = [];
  let checkedPackages = 0;

  const globs = workspace.packages ?? ["packages/*", "services/*", "frontend", "tools/*"];
  for (const glob of globs) {
    const dirs = findFiles(glob, rootDir);
    for (const dir of dirs) {
      const manifestPath = path.join(dir, "package.json");
      if (!fs.existsSync(manifestPath)) continue;

      let manifest: PackageJson;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        continue;
      }

      const relPath = path.relative(rootDir, manifestPath);
      checkedPackages++;

      allViolations.push(
        ...checkCatalogDrift(manifest, relPath, catalog),
        ...checkWorkspaceProtocol(manifest, relPath),
        ...checkEnginesConsistency(manifest, relPath, rootNodeRange),
      );
    }
  }

  return { violations: allViolations, checkedPackages };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function formatReport(result: LintResult): void {
  const { violations, checkedPackages } = result;
  console.log(`\nWorkspace lint — checked ${checkedPackages} package(s)\n`);

  if (violations.length === 0) {
    console.log("✓  No violations found.\n");
    return;
  }

  // Group by file
  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const existing = byFile.get(v.file) ?? [];
    existing.push(v);
    byFile.set(v.file, existing);
  }

  for (const [file, vs] of byFile) {
    console.log(`${file}`);
    for (const v of vs) {
      console.log(
        `  [${v.rule}] ${v.field}\n` +
        `    expected: ${v.expected}\n` +
        `    actual:   ${v.actual}`,
      );
    }
    console.log();
  }

  console.error(`✖  ${violations.length} violation(s) in ${byFile.size} file(s)\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const rootDir = rootIdx !== -1 ? (args[rootIdx + 1] ?? process.cwd()) : process.cwd();

  let result: LintResult;
  try {
    result = await lint(rootDir);
  } catch (err) {
    console.error(`workspace-lint: ${(err as Error).message}`);
    process.exit(1);
  }

  formatReport(result);

  if (result.violations.length > 0) {
    process.exit(1);
  }
}

// Run only when executed directly (not when imported by tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
