import { describe, it, expect } from "vitest";
import { extractAddedPaths, checkPaths, runGuard, FORBIDDEN_PATTERNS } from "./artifact-guard.js";

// ---------------------------------------------------------------------------
// extractAddedPaths
// ---------------------------------------------------------------------------

describe("extractAddedPaths", () => {
  it("extracts paths from unified diff +++ lines", () => {
    const diff = `
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+console.log("hello");
`.trim();
    expect(extractAddedPaths(diff)).toContain("src/index.ts");
  });

  it("extracts paths from git diff header lines", () => {
    const diff = `diff --git a/package.tgz b/package.tgz
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/package.tgz differ`;
    expect(extractAddedPaths(diff)).toContain("package.tgz");
  });

  it("extracts renamed paths", () => {
    const diff = `
diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
`.trim();
    expect(extractAddedPaths(diff)).toContain("new.ts");
  });

  it("ignores /dev/null", () => {
    const diff = `--- /dev/null\n+++ b/src/new.ts`;
    const paths = extractAddedPaths(diff);
    expect(paths).not.toContain("/dev/null");
    expect(paths).toContain("src/new.ts");
  });

  it("returns empty array for empty diff", () => {
    expect(extractAddedPaths("")).toEqual([]);
  });

  it("handles name-only git diff format (one path per line with +++ prefix)", () => {
    const diff = `+++ b/src/foo.ts\n+++ b/src/bar.ts`;
    expect(extractAddedPaths(diff)).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

// ---------------------------------------------------------------------------
// checkPaths — individual pattern tests
// ---------------------------------------------------------------------------

describe("checkPaths", () => {
  const violates = (path: string) => checkPaths([path]).length > 0;
  const passes = (path: string) => checkPaths([path]).length === 0;

  it("flags .tgz files", () => {
    expect(violates("dist/my-package-1.0.0.tgz")).toBe(true);
    expect(violates("packages/contracts/contracts-1.0.0.tgz")).toBe(true);
  });

  it("flags node_modules directories", () => {
    expect(violates("node_modules/lodash/index.js")).toBe(true);
    expect(violates("services/api/node_modules/express/index.js")).toBe(true);
  });

  it("flags .env files in any form", () => {
    expect(violates(".env")).toBe(true);
    expect(violates(".env.local")).toBe(true);
    expect(violates(".env.production")).toBe(true);
    expect(violates("services/api/.env")).toBe(true);
  });

  it("flags .pem files", () => {
    expect(violates("certs/server.pem")).toBe(true);
    expect(violates("server.PEM")).toBe(true);
  });

  it("flags .p12 and .pfx files", () => {
    expect(violates("keystore.p12")).toBe(true);
    expect(violates("keystore.pfx")).toBe(true);
  });

  it("flags SSH private key files", () => {
    expect(violates("id_rsa")).toBe(true);
    expect(violates(".ssh/id_ecdsa")).toBe(true);
    expect(violates("keys/id_ed25519")).toBe(true);
  });

  it("flags .key files", () => {
    expect(violates("server.key")).toBe(true);
    expect(violates("infra/tls.key")).toBe(true);
  });

  it("does NOT flag safe TypeScript/JSON files", () => {
    expect(passes("src/index.ts")).toBe(true);
    expect(passes("package.json")).toBe(true);
    expect(passes("tsconfig.json")).toBe(true);
    expect(passes(".env.example")).toBe(false); // .env.example still flagged (contains .env)
    expect(passes("README.md")).toBe(true);
    expect(passes("services/api/src/config.ts")).toBe(true);
  });

  it("does NOT flag id_rsa.pub (public key, not private)", () => {
    // id_rsa.pub does not match /(^|\/)id_(rsa|ecdsa|ed25519)$/ due to .pub suffix
    expect(passes("id_rsa.pub")).toBe(true);
  });

  it("returns the correct reason for a .tgz violation", () => {
    const violations = checkPaths(["my-package.tgz"]);
    expect(violations[0]?.reason).toMatch(/\.tgz/);
    expect(violations[0]?.reason).toMatch(/packaged npm artefact/i);
  });
});

// ---------------------------------------------------------------------------
// runGuard
// ---------------------------------------------------------------------------

describe("runGuard", () => {
  it("passes for a clean diff with no violations", () => {
    const diff = `+++ b/src/index.ts\n+++ b/README.md`;
    const result = runGuard(diff);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails when a .tgz is added", () => {
    const diff = `+++ b/dist/package-1.0.0.tgz`;
    const result = runGuard(diff);
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.path).toBe("dist/package-1.0.0.tgz");
  });

  it("fails when a .env file is added", () => {
    const diff = `diff --git a/.env.local b/.env.local\n+++ b/.env.local`;
    const result = runGuard(diff);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.path.includes(".env"))).toBe(true);
  });

  it("fails when node_modules is added", () => {
    const diff = `+++ b/node_modules/axios/index.js`;
    const result = runGuard(diff);
    expect(result.passed).toBe(false);
  });

  it("reports all violations when multiple prohibited files are in the diff", () => {
    const diff = [
      "+++ b/dist/package.tgz",
      "+++ b/.env.production",
      "+++ b/certs/server.pem",
      "+++ b/src/clean.ts",
    ].join("\n");
    const result = runGuard(diff);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(3);
  });

  it("passes for an empty diff", () => {
    const result = runGuard("");
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN_PATTERNS completeness
// ---------------------------------------------------------------------------

describe("FORBIDDEN_PATTERNS", () => {
  it("covers all 7 prohibited file categories", () => {
    // Ensure the patterns list is not accidentally truncated
    expect(FORBIDDEN_PATTERNS.length).toBeGreaterThanOrEqual(7);
  });

  it("every pattern has a non-empty reason", () => {
    for (const { reason } of FORBIDDEN_PATTERNS) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});
