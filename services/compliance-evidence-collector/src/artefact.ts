/**
 * Artefact writer — builds S3 keys, serialises evidence, computes SHA-256,
 * and produces the per-run manifest.
 *
 * Key layout: {env}/{group}/{yyyy}/{mm}/{dd}/{controlId}-{runId}.json
 *
 * Security:
 *   - assertNoPii() scans every artefact payload for redaction-path keys
 *     before upload as defence-in-depth (AC8).
 *   - The collector role has PutObject only — no DeleteObject, no PutObjectRetention.
 */

import { createHash } from "node:crypto";
import type { EvidencePayload, GapRecord, ManifestEntry, RunManifest } from "./types.js";

/** Keys that must never appear in an evidence artefact (mirrors EXPORT_EXCLUDED_KEYS). */
export const EVIDENCE_PII_KEYS = new Set([
  "email", "firstName", "lastName", "first_name", "last_name",
  "passwordHash", "password", "cardNumber", "cvv", "cvc",
  "rawToken", "refreshTokenHash", "passportNumber", "dateOfBirth",
  "date_of_birth", "passport_number", "phone", "phoneNumber",
  "wrappedDek", "ciphertext", "ip_address", "ipAddress",
]);

export function assertNoPii(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (EVIDENCE_PII_KEYS.has(key)) {
      throw new Error(`Evidence artefact contains PII key: ${fullPath}`);
    }
    assertNoPii(value, fullPath);
  }
}

export function buildS3Key(opts: {
  environment: string;
  controlGroup: string;
  date: Date;
  controlId: string;
  runId: string;
}): string {
  const yyyy = opts.date.getUTCFullYear();
  const mm = String(opts.date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(opts.date.getUTCDate()).padStart(2, "0");
  return `${opts.environment}/${opts.controlGroup}/${yyyy}/${mm}/${dd}/${opts.controlId}-${opts.runId}.json`;
}

export function serialiseArtefact(payload: EvidencePayload | GapRecord): {
  content: string;
  sha256: string;
  sizeBytes: number;
} {
  assertNoPii(payload);
  const content = JSON.stringify(payload, null, 2);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { content, sha256, sizeBytes: Buffer.byteLength(content, "utf8") };
}

export function buildManifest(opts: {
  runId: string;
  environment: string;
  runStartedAt: Date;
  runCompletedAt: Date;
  date: Date;
  entries: ManifestEntry[];
  gaps: GapRecord[];
}): RunManifest {
  const planned = opts.gaps.filter((g) => g.reason === "planned").length;
  const failures = opts.gaps.filter((g) => g.reason === "source_failure").length;
  const noData = opts.gaps.filter((g) => g.reason === "no_data").length;

  const dateStr = opts.date.toISOString().slice(0, 10);

  return {
    schemaVersion: "1.0",
    runId: opts.runId,
    environment: opts.environment,
    runStartedAt: opts.runStartedAt.toISOString(),
    runCompletedAt: opts.runCompletedAt.toISOString(),
    date: dateStr,
    artefacts: opts.entries,
    gaps: opts.gaps,
    totals: {
      collected: opts.entries.length,
      gaps: noData + failures,
      planned,
      failures,
    },
  };
}
