/**
 * Unit tests for compliance evidence collector (WO-105).
 *
 * Tests cover:
 *   - Control matrix loading and schema validation
 *   - Adapter drift detection (AC7: fail fast on missing adapter)
 *   - Source adapter gap detection (no data → explicit gap record)
 *   - Artefact naming and S3 key layout
 *   - Manifest generation
 *   - Personal-data absence assertion (AC8: assertNoPii)
 *   - Monthly report aggregation (AC9)
 *   - Planned controls produce planned gap, not failure gap
 *   - Source failure → gap record, not run abort
 */

import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadControlMatrix, validateAdapters } from "../src/matrix.js";
import { assertNoPii, buildS3Key, serialiseArtefact } from "../src/artefact.js";
import { SourceRegistry } from "../src/registry.js";
import { runCollector } from "../src/collector.js";
import { buildMonthlyReport } from "../src/report.js";
import type { EvidenceSource, EvidenceResult, EvidencePayload, GapRecord, RunManifest } from "../src/types.js";
import { EvidenceSourceError } from "../src/types.js";
import type { StoragePort } from "../src/collector.js";
import { EVIDENCE_PII_KEYS } from "../src/artefact.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_MATRIX = resolve(__dirname, "../fixtures/sample-control-matrix.yaml");
const TEST_DATE = new Date("2024-09-15T06:00:00.000Z");
const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENVIRONMENT = "test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubSource(name: string, result: EvidenceResult | "gap" | "failure"): EvidenceSource {
  return {
    name,
    gather: vi.fn().mockImplementation(async (date, runId, controlId, controlGroup) => {
      if (result === "gap") {
        return {
          kind: "gap",
          controlId, controlGroup,
          evidenceSource: name,
          collectedAt: new Date().toISOString(),
          runId,
          period: { date: date.toISOString().slice(0, 10) },
          reason: "no_data",
        } as GapRecord;
      }
      if (result === "failure") {
        throw new EvidenceSourceError(controlId, "test_failure");
      }
      return result;
    }),
  };
}

function makeStorage(): { storage: StoragePort; written: Map<string, string> } {
  const written = new Map<string, string>();
  const storage: StoragePort = {
    putArtefact: vi.fn().mockImplementation(async (key, content) => { written.set(key, content); }),
    getManifest: vi.fn().mockResolvedValue(null),
  };
  return { storage, written };
}

// ---------------------------------------------------------------------------
// Matrix loading
// ---------------------------------------------------------------------------

describe("loadControlMatrix", () => {
  it("loads a valid matrix from a fixture file", () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    expect(matrix.schema_version).toBe("1.0");
    expect(matrix.controls.length).toBe(3);
    expect(matrix.controls[0].id).toBe("cc6-audit-chain");
  });

  it("throws if the file does not exist", () => {
    expect(() => loadControlMatrix("/nonexistent/path.yaml")).toThrow("Cannot read control matrix");
  });
});

// ---------------------------------------------------------------------------
// Adapter drift detection (AC7)
// ---------------------------------------------------------------------------

describe("validateAdapters", () => {
  it("passes when all non-planned controls have a registered adapter", () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    const names = new Set(["audit_chain_verifier", "purge_run_summary"]);
    expect(() => validateAdapters(matrix, names)).not.toThrow();
  });

  it("throws with a descriptive error listing missing adapters", () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    // Only one adapter registered — purge_run_summary is missing
    const names = new Set(["audit_chain_verifier"]);
    expect(() => validateAdapters(matrix, names)).toThrow("purge_run_summary");
    expect(() => validateAdapters(matrix, names)).toThrow("cc7-purge-summary");
  });

  it("does not require an adapter for planned controls", () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    // future_adapter is for a planned control — should not be required
    const names = new Set(["audit_chain_verifier", "purge_run_summary"]);
    expect(() => validateAdapters(matrix, names)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Artefact naming and S3 key layout
// ---------------------------------------------------------------------------

describe("buildS3Key", () => {
  it("produces the expected dated key layout", () => {
    const key = buildS3Key({
      environment: "staging",
      controlGroup: "CC6",
      date: new Date("2024-09-15"),
      controlId: "cc6-audit-chain",
      runId: "run-123",
    });
    expect(key).toBe("staging/CC6/2024/09/15/cc6-audit-chain-run-123.json");
  });

  it("zero-pads month and day", () => {
    const key = buildS3Key({
      environment: "prod",
      controlGroup: "CC7",
      date: new Date("2024-01-05"),
      controlId: "cc7-purge",
      runId: "run-1",
    });
    expect(key).toContain("/2024/01/05/");
  });
});

// ---------------------------------------------------------------------------
// PII assertion (AC8)
// ---------------------------------------------------------------------------

describe("assertNoPii", () => {
  it("passes for a clean evidence payload", () => {
    expect(() => assertNoPii({ count: 42, controlId: "cc6-audit-chain" })).not.toThrow();
  });

  it("throws for a top-level PII key", () => {
    expect(() => assertNoPii({ email: "test@example.com" })).toThrow("email");
  });

  it("throws for a nested PII key", () => {
    expect(() => assertNoPii({ data: { passwordHash: "hash" } })).toThrow("passwordHash");
  });

  it("covers all keys in EVIDENCE_PII_KEYS", () => {
    for (const key of EVIDENCE_PII_KEYS) {
      expect(() => assertNoPii({ [key]: "value" })).toThrow(key);
    }
  });
});

// ---------------------------------------------------------------------------
// serialiseArtefact
// ---------------------------------------------------------------------------

describe("serialiseArtefact", () => {
  it("returns content, sha256, and sizeBytes", () => {
    const payload: EvidencePayload = {
      kind: "evidence",
      controlId: "cc6-audit-chain",
      controlGroup: "CC6",
      evidenceSource: "audit_chain_verifier",
      collectedAt: "2024-09-15T06:00:00.000Z",
      runId: RUN_ID,
      period: { date: "2024-09-15" },
      data: { rowsVerified: 100, chainOk: true },
    };
    const result = serialiseArtefact(payload);
    expect(result.content).toContain("rowsVerified");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("throws if the payload contains a PII key", () => {
    const bad = {
      kind: "evidence" as const,
      controlId: "x", controlGroup: "Y",
      evidenceSource: "x",
      collectedAt: "", runId: "", period: { date: "" },
      data: { email: "leaked@example.com" },
    };
    expect(() => serialiseArtefact(bad)).toThrow("email");
  });
});

// ---------------------------------------------------------------------------
// runCollector: gap detection, manifest generation
// ---------------------------------------------------------------------------

describe("runCollector", () => {
  it("produces evidence artefacts and a manifest", async () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    const registry = new SourceRegistry();

    const evidencePayload: EvidencePayload = {
      kind: "evidence",
      controlId: "cc6-audit-chain",
      controlGroup: "CC6",
      evidenceSource: "audit_chain_verifier",
      collectedAt: TEST_DATE.toISOString(),
      runId: RUN_ID,
      period: { date: "2024-09-15" },
      data: { rowsVerified: 50, chainOk: true, checkpointRowId: "row-50" },
    };

    registry.register(makeStubSource("audit_chain_verifier", evidencePayload));
    registry.register(makeStubSource("purge_run_summary", evidencePayload));

    const { storage, written } = makeStorage();
    const result = await runCollector({ environment: ENVIRONMENT, date: TEST_DATE, matrix, registry, storage });

    expect(result.manifest.totals.collected).toBe(2);
    expect(result.manifest.totals.gaps).toBe(0);
    // planned gap for cc7-future-control
    expect(result.manifest.totals.planned).toBe(1);
    expect(written.size).toBeGreaterThan(0);
  });

  it("records an explicit gap artefact when a source has no data", async () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    const registry = new SourceRegistry();
    registry.register(makeStubSource("audit_chain_verifier", "gap"));
    registry.register(makeStubSource("purge_run_summary", "gap"));

    const { storage } = makeStorage();
    const result = await runCollector({ environment: ENVIRONMENT, date: TEST_DATE, matrix, registry, storage });

    expect(result.manifest.totals.collected).toBe(0);
    expect(result.manifest.totals.gaps).toBe(2);
    expect(result.manifest.gaps.every((g) => g.reason === "no_data")).toBe(true);
  });

  it("records a gap artefact on source failure and continues the run", async () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    const registry = new SourceRegistry();
    registry.register(makeStubSource("audit_chain_verifier", "failure"));
    registry.register(makeStubSource("purge_run_summary", "gap"));

    const { storage } = makeStorage();
    const result = await runCollector({ environment: ENVIRONMENT, date: TEST_DATE, matrix, registry, storage });

    // Run continued despite one failure
    expect(result.hadFailures).toBe(true);
    const failGap = result.manifest.gaps.find((g) => g.controlId === "cc6-audit-chain");
    expect(failGap?.reason).toBe("source_failure");
  });

  it("records a planned gap for controls with status=planned", async () => {
    const matrix = loadControlMatrix(FIXTURE_MATRIX);
    const registry = new SourceRegistry();
    registry.register(makeStubSource("audit_chain_verifier", "gap"));
    registry.register(makeStubSource("purge_run_summary", "gap"));

    const { storage } = makeStorage();
    const result = await runCollector({ environment: ENVIRONMENT, date: TEST_DATE, matrix, registry, storage });

    const plannedGap = result.manifest.gaps.find((g) => g.controlId === "cc7-future-control");
    expect(plannedGap?.reason).toBe("planned");
    // planned should not count toward hadFailures
    expect(result.hadFailures).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Monthly report (AC9)
// ---------------------------------------------------------------------------

describe("buildMonthlyReport", () => {
  const start = new Date("2024-09-01");
  const end = new Date("2024-09-30");

  it("aggregates artefacts and gaps per control", () => {
    const manifests: RunManifest[] = [
      {
        schemaVersion: "1.0",
        runId: "run-1",
        environment: "test",
        runStartedAt: "2024-09-15T06:00:00Z",
        runCompletedAt: "2024-09-15T06:01:00Z",
        date: "2024-09-15",
        artefacts: [
          { controlId: "cc6-audit-chain", controlGroup: "CC6", s3Key: "test/CC6/2024/09/15/x.json", sha256: "abc", collectedAt: "", sizeBytes: 100 },
        ],
        gaps: [
          { kind: "gap", controlId: "cc7-purge-summary", controlGroup: "CC7", evidenceSource: "purge_run_summary", collectedAt: "", runId: "run-1", period: { date: "2024-09-15" }, reason: "no_data" },
        ],
        totals: { collected: 1, gaps: 1, planned: 0, failures: 0 },
      },
    ];

    const report = buildMonthlyReport({ environment: "test", start, end, manifests });

    expect(report.schemaVersion).toBe("1.0");
    expect(report.controls.find((c) => c.controlId === "cc6-audit-chain")?.artefactsCollected).toBe(1);
    expect(report.controls.find((c) => c.controlId === "cc7-purge-summary")?.gapsCount).toBe(1);
    expect(report.totals.daysInWindow).toBe(30);
    expect(report.totals.totalArtefacts).toBe(1);
    expect(report.totals.totalGaps).toBe(1);
  });

  it("handles an empty manifest set", () => {
    const report = buildMonthlyReport({ environment: "test", start, end, manifests: [] });
    expect(report.controls).toHaveLength(0);
    expect(report.totals.totalArtefacts).toBe(0);
  });
});
