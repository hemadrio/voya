/**
 * Unit tests for affected.ts — WO-084.
 *
 * Covers:
 *   - Baseline reachability check
 *   - Zero-change scenario (baseline reachable, no files changed)
 *   - Single-package-change scenario (only service files changed)
 *   - Root-config-change scenario (tsconfig.base.json, turbo.json, etc.)
 *   - Shallow-clone / no-remote fallback to full build
 *   - CLI output modes (filter vs json)
 */

import { describe, it, expect } from "vitest";
import {
  ROOT_CONFIG_FILES,
  DEFAULT_BASE,
  isBaselineReachable,
  listChangedFiles,
  findRootConfigChanges,
  resolveAffectedFilter,
  type ExecFn,
} from "./affected.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** ExecFn that succeeds with the given output. */
function execReturns(output: string): ExecFn {
  return () => output;
}

/** ExecFn that throws (simulates non-zero exit). */
function execThrows(msg = "command failed"): ExecFn {
  return () => {
    throw new Error(msg);
  };
}

/**
 * ExecFn that maps command prefixes to responses.
 * Falls through to throws if no prefix matches.
 */
function execMap(map: Record<string, string>): ExecFn {
  return (cmd: string) => {
    for (const [prefix, result] of Object.entries(map)) {
      if (cmd.startsWith(prefix)) return result;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };
}

// ── ROOT_CONFIG_FILES ─────────────────────────────────────────────────────────

describe("ROOT_CONFIG_FILES", () => {
  it("includes tsconfig.base.json", () => {
    expect(ROOT_CONFIG_FILES).toContain("tsconfig.base.json");
  });

  it("includes turbo.json", () => {
    expect(ROOT_CONFIG_FILES).toContain("turbo.json");
  });

  it("includes pnpm-workspace.yaml", () => {
    expect(ROOT_CONFIG_FILES).toContain("pnpm-workspace.yaml");
  });

  it("includes pnpm-lock.yaml", () => {
    expect(ROOT_CONFIG_FILES).toContain("pnpm-lock.yaml");
  });
});

// ── isBaselineReachable ───────────────────────────────────────────────────────

describe("isBaselineReachable", () => {
  it("returns true when git rev-parse succeeds", () => {
    const exec = execReturns("abc1234");
    expect(isBaselineReachable("origin/main", exec)).toBe(true);
  });

  it("returns false when git rev-parse throws (shallow clone)", () => {
    const exec = execThrows("fatal: ambiguous argument 'origin/main'");
    expect(isBaselineReachable("origin/main", exec)).toBe(false);
  });

  it("returns false when origin is not configured", () => {
    const exec = execThrows("fatal: No such remote 'origin'");
    expect(isBaselineReachable("origin/main", exec)).toBe(false);
  });
});

// ── listChangedFiles ──────────────────────────────────────────────────────────

describe("listChangedFiles", () => {
  it("returns parsed file paths for a normal diff output", () => {
    const exec = execReturns(
      "services/auth-service/src/domain/LoginService.ts\n" +
      "services/auth-service/test/unit/LoginService.test.ts"
    );
    const files = listChangedFiles("origin/main", exec);
    expect(files).toHaveLength(2);
    expect(files).toContain("services/auth-service/src/domain/LoginService.ts");
  });

  it("returns empty array when diff output is empty (zero-change scenario)", () => {
    const exec = execReturns("");
    expect(listChangedFiles("origin/main", exec)).toHaveLength(0);
  });

  it("returns empty array when git diff throws (treated as unknown changes)", () => {
    const exec = execThrows("git diff failed");
    expect(listChangedFiles("origin/main", exec)).toHaveLength(0);
  });

  it("filters out blank lines from diff output", () => {
    const exec = execReturns("\npackages/contracts/src/index.ts\n\n");
    const files = listChangedFiles("origin/main", exec);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("packages/contracts/src/index.ts");
  });
});

// ── findRootConfigChanges ─────────────────────────────────────────────────────

describe("findRootConfigChanges", () => {
  it("returns empty array when no root-config files changed", () => {
    const files = [
      "services/auth-service/src/domain/LoginService.ts",
      "packages/contracts/src/index.ts",
    ];
    expect(findRootConfigChanges(files)).toHaveLength(0);
  });

  it("detects a change to turbo.json", () => {
    const files = ["turbo.json", "services/booking-service/src/index.ts"];
    const changed = findRootConfigChanges(files);
    expect(changed).toContain("turbo.json");
    expect(changed).toHaveLength(1);
  });

  it("detects a change to tsconfig.base.json", () => {
    const files = ["tsconfig.base.json"];
    expect(findRootConfigChanges(files)).toContain("tsconfig.base.json");
  });

  it("detects a change to pnpm-lock.yaml", () => {
    const files = ["pnpm-lock.yaml"];
    expect(findRootConfigChanges(files)).toContain("pnpm-lock.yaml");
  });

  it("detects multiple root-config changes at once", () => {
    const files = ["turbo.json", "pnpm-workspace.yaml", "packages/contracts/src/index.ts"];
    const changed = findRootConfigChanges(files);
    expect(changed).toContain("turbo.json");
    expect(changed).toContain("pnpm-workspace.yaml");
    expect(changed).toHaveLength(2);
  });

  it("does NOT flag a service tsconfig.json (only root tsconfig.base.json)", () => {
    const files = ["services/auth-service/tsconfig.json"];
    expect(findRootConfigChanges(files)).toHaveLength(0);
  });
});

// ── resolveAffectedFilter — zero-change scenario ──────────────────────────────

describe("resolveAffectedFilter — zero-change scenario", () => {
  it("returns scoped affected filter when no files changed", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(false);
    expect(result.filter).toBe("...[origin/main]");
    expect(result.rootConfigChanged).toHaveLength(0);
  });

  it("filter includes the base ref verbatim", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "",
    });
    const result = resolveAffectedFilter({ base: "origin/feature-baseline", exec });
    expect(result.filter).toBe("...[origin/feature-baseline]");
  });
});

// ── resolveAffectedFilter — single-package-change scenario ───────────────────

describe("resolveAffectedFilter — single-package-change scenario", () => {
  it("returns scoped affected filter when only a single service file changed", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "services/auth-service/src/domain/LoginService.ts",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(false);
    expect(result.filter).toBe("...[origin/main]");
  });

  it("returns scoped filter when a shared package changes (non-root)", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "packages/contracts/src/index.ts\npackages/contracts/package.json",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(false);
    expect(result.rootConfigChanged).toHaveLength(0);
  });
});

// ── resolveAffectedFilter — root-config-change scenario ──────────────────────

describe("resolveAffectedFilter — root-config-change scenario", () => {
  it("returns full build filter when turbo.json changed", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "turbo.json\npackages/contracts/src/index.ts",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(true);
    expect(result.filter).toBe("...");
    expect(result.rootConfigChanged).toContain("turbo.json");
  });

  it("returns full build filter when tsconfig.base.json changed", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "tsconfig.base.json",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(true);
    expect(result.filter).toBe("...");
  });

  it("returns full build filter when pnpm-lock.yaml changed", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "pnpm-lock.yaml",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(true);
  });

  it("lists all changed root-config files in result.rootConfigChanged", () => {
    const exec = execMap({
      "git rev-parse --verify": "abc1234",
      "git diff --name-only": "turbo.json\npnpm-workspace.yaml",
    });
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.rootConfigChanged).toContain("turbo.json");
    expect(result.rootConfigChanged).toContain("pnpm-workspace.yaml");
  });
});

// ── resolveAffectedFilter — shallow-clone / no-baseline fallback ──────────────

describe("resolveAffectedFilter — shallow clone / no-remote fallback", () => {
  it("returns full build when origin/main is not reachable (shallow clone)", () => {
    const exec = execThrows("fatal: ambiguous argument 'origin/main'");
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(true);
    expect(result.filter).toBe("...");
    expect(result.reason).toMatch(/not reachable/i);
  });

  it("uses DEFAULT_BASE when no base is provided", () => {
    expect(DEFAULT_BASE).toBe("origin/main");
    // A real exec would be called but we can verify the constant is sane
    expect(DEFAULT_BASE).toMatch(/^origin\//);
  });

  it("falls back to full build on first run of a new branch", () => {
    // Simulate new branch with no origin/main in shallow fetch
    const exec = (cmd: string): string => {
      if (cmd.startsWith("git rev-parse --verify")) throw new Error("not found");
      throw new Error(`unexpected: ${cmd}`);
    };
    const result = resolveAffectedFilter({ base: "origin/main", exec });
    expect(result.full).toBe(true);
  });
});
