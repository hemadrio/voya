import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCatalogDrift,
  checkWorkspaceProtocol,
  checkEnginesConsistency,
  lint,
  type Violation,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

const CATALOG: Record<string, string> = {
  zod: "^3.23.8",
  pino: "^8.21.0",
  express: "^4.19.2",
  typescript: "5.5.3",
  vitest: "^1.6.0",
  "@types/node": "^20.14.0",
};

const ROOT_NODE_RANGE = ">=20.0.0 <21.0.0";

// ---------------------------------------------------------------------------
// Unit: checkCatalogDrift
// ---------------------------------------------------------------------------

describe("checkCatalogDrift", () => {
  it("returns no violations for correct catalog usage", () => {
    const violations = checkCatalogDrift(
      {
        dependencies: { zod: "catalog:", pino: "catalog:" },
        devDependencies: { typescript: "catalog:", vitest: "catalog:" },
      },
      "pkg/package.json",
      CATALOG,
    );
    expect(violations).toHaveLength(0);
  });

  it("flags literal versions for catalogued deps", () => {
    const violations = checkCatalogDrift(
      {
        dependencies: { zod: "^3.22.0" },
        devDependencies: { typescript: "5.4.5" },
      },
      "pkg/package.json",
      CATALOG,
    );
    expect(violations).toHaveLength(2);
    const rules = violations.map((v) => v.rule);
    expect(rules.every((r) => r === "catalog-drift")).toBe(true);
    expect(violations.find((v) => v.field.includes("zod"))?.actual).toBe("^3.22.0");
    expect(violations.find((v) => v.field.includes("typescript"))?.actual).toBe("5.4.5");
  });

  it("accepts catalog:<name> prefix", () => {
    const violations = checkCatalogDrift(
      { dependencies: { zod: "catalog:default" } },
      "pkg/package.json",
      CATALOG,
    );
    expect(violations).toHaveLength(0);
  });

  it("ignores deps not in catalog", () => {
    const violations = checkCatalogDrift(
      { dependencies: { "some-unlisted": "^1.0.0" } },
      "pkg/package.json",
      CATALOG,
    );
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkWorkspaceProtocol
// ---------------------------------------------------------------------------

describe("checkWorkspaceProtocol", () => {
  it("returns no violations for workspace:* usage", () => {
    const violations = checkWorkspaceProtocol(
      { dependencies: { "@travel/contracts": "workspace:*" } },
      "pkg/package.json",
    );
    expect(violations).toHaveLength(0);
  });

  it("flags @travel/* deps without workspace: protocol", () => {
    const violations = checkWorkspaceProtocol(
      {
        dependencies: {
          "@travel/contracts": "^0.1.0",
          "@travel/config": "0.1.0",
        },
      },
      "pkg/package.json",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.rule === "workspace-protocol")).toBe(true);
    expect(violations.every((v) => v.expected === "workspace:*")).toBe(true);
  });

  it("ignores non-@travel/ deps", () => {
    const violations = checkWorkspaceProtocol(
      { dependencies: { express: "^4.19.2" } },
      "pkg/package.json",
    );
    expect(violations).toHaveLength(0);
  });

  it("accepts workspace:^ and workspace:~", () => {
    const violations = checkWorkspaceProtocol(
      { dependencies: { "@travel/contracts": "workspace:^" } },
      "pkg/package.json",
    );
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkEnginesConsistency
// ---------------------------------------------------------------------------

describe("checkEnginesConsistency", () => {
  it("returns no violations when engines match root", () => {
    const violations = checkEnginesConsistency(
      { engines: { node: ">=20.0.0 <21.0.0" } },
      "pkg/package.json",
      ROOT_NODE_RANGE,
    );
    expect(violations).toHaveLength(0);
  });

  it("flags missing engines.node", () => {
    const violations = checkEnginesConsistency(
      {},
      "pkg/package.json",
      ROOT_NODE_RANGE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.actual).toBe("(missing)");
    expect(violations[0]?.rule).toBe("engines-consistency");
  });

  it("flags engines.node with lower minimum major", () => {
    const violations = checkEnginesConsistency(
      { engines: { node: ">=18.0.0" } },
      "pkg/package.json",
      ROOT_NODE_RANGE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.actual).toBe(">=18.0.0");
  });

  it("accepts a wider compatible range", () => {
    const violations = checkEnginesConsistency(
      { engines: { node: ">=20.0.0" } },
      "pkg/package.json",
      ROOT_NODE_RANGE,
    );
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: fixture directories
// ---------------------------------------------------------------------------

describe("fixture: compliant package", () => {
  it("produces zero violations", async () => {
    const compliantDir = path.join(FIXTURES, "compliant");
    const violations = [
      ...checkCatalogDrift(
        { dependencies: { zod: "catalog:", pino: "catalog:" }, devDependencies: { typescript: "catalog:", vitest: "catalog:", "@types/node": "catalog:" } },
        "package.json",
        CATALOG,
      ),
      ...checkWorkspaceProtocol(
        { dependencies: { "@travel/contracts": "workspace:*" } },
        "package.json",
      ),
      ...checkEnginesConsistency(
        { engines: { node: ">=20.0.0 <21.0.0" } },
        "package.json",
        ROOT_NODE_RANGE,
      ),
    ];
    expect(violations).toHaveLength(0);
  });
});

describe("fixture: catalog-drift", () => {
  it("detects literal versions for catalogued deps", () => {
    const violations = checkCatalogDrift(
      {
        dependencies: { zod: "^3.22.0", pino: "^8.20.0" },
        devDependencies: { typescript: "5.4.5", vitest: "catalog:" },
      },
      "package.json",
      CATALOG,
    );
    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(violations.every((v) => v.rule === "catalog-drift")).toBe(true);
  });
});

describe("fixture: no-workspace-protocol", () => {
  it("detects missing workspace: prefix on internal deps", () => {
    const violations = checkWorkspaceProtocol(
      {
        dependencies: {
          "@travel/contracts": "^0.1.0",
          "@travel/config": "0.1.0",
          zod: "catalog:",
        },
      },
      "package.json",
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.rule === "workspace-protocol")).toBe(true);
  });
});

describe("fixture: engines-mismatch", () => {
  it("detects engines.node below root minimum", () => {
    const violations = checkEnginesConsistency(
      { engines: { node: ">=18.0.0" } },
      "package.json",
      ROOT_NODE_RANGE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("engines-consistency");
  });
});
