/**
 * Import-boundary test — AC10.
 *
 * Asserts that no domain service module imports `express` or `@prisma/client`
 * directly. Controllers are allowed to import Express types (for Request/Response),
 * but pure domain modules (under src/domain/) must not.
 *
 * Strategy: scan src/domain/ directories via the filesystem and grep for
 * forbidden import patterns. This runs with no external dependencies.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// Domain directories — pure business logic, must not import HTTP or ORM libs
const DOMAIN_DIRS = [
  "services/booking-service/src/domain",
  "services/payment-service/src/domain",
  "services/auth-service/src/domain",
  "services/user-service/src/domain",
  "services/search-service/src/domain",
];

const FORBIDDEN_PATTERNS = [
  /from\s+['"]express['"]/,
  /require\s*\(\s*['"]express['"]/,
  /from\s+['"]@prisma\/client['"]/,
  /require\s*\(\s*['"]@prisma\/client['"]/,
];

function scanDirectory(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const violations: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      violations.push(...scanDirectory(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      const content = fs.readFileSync(fullPath, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${fullPath}: matches ${pattern}`);
        }
      }
    }
  }

  return violations;
}

describe("import-boundary lint — AC10", () => {
  it("domain service modules do not import express", () => {
    const violations: string[] = [];
    for (const domainDir of DOMAIN_DIRS) {
      const absDir = path.join(REPO_ROOT, domainDir);
      violations.push(...scanDirectory(absDir));
    }

    if (violations.length > 0) {
      throw new Error(
        `Domain modules must not import express or @prisma/client:\n${violations.join("\n")}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
