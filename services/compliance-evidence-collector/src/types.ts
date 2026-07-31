/**
 * EvidenceSource port — all adapter implementations satisfy this interface.
 *
 * Constraints:
 *   - gather() must NEVER include personal data in the payload. Counts,
 *     hashes, identifiers, and timings only (AC8).
 *   - On any failure the adapter throws EvidenceSourceError (not a raw error).
 *   - The return type is either a clean EvidencePayload or a GapRecord when
 *     the source produces nothing for the given date.
 */

export interface EvidencePayload {
  kind: "evidence";
  controlId: string;
  controlGroup: string;
  evidenceSource: string;
  collectedAt: string;          // ISO-8601
  runId: string;
  period: { date: string };     // yyyy-mm-dd
  /** Evidence data — counts, hashes, identifiers, timings. NO PII. */
  data: Record<string, unknown>;
}

export interface GapRecord {
  kind: "gap";
  controlId: string;
  controlGroup: string;
  evidenceSource: string;
  collectedAt: string;
  runId: string;
  period: { date: string };
  reason: string;               // "no_data" | "source_failure" | "planned"
  errorClass?: string;          // for source_failure
  referenceId?: string;         // correlation identifier
}

export type EvidenceResult = EvidencePayload | GapRecord;

export class EvidenceSourceError extends Error {
  constructor(
    public readonly controlId: string,
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(`[${controlId}] ${reason}`);
    this.name = "EvidenceSourceError";
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** The port every source adapter must satisfy. */
export interface EvidenceSource {
  /** Unique name — must match the evidence_source field in control-matrix.yaml. */
  readonly name: string;

  /**
   * Gather evidence for the given calendar date.
   * Returns EvidencePayload on success, GapRecord when the source has no data.
   * Throws EvidenceSourceError on unrecoverable failure.
   */
  gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult>;
}

/** Artefact manifest produced once per collector run. */
export interface RunManifest {
  schemaVersion: "1.0";
  runId: string;
  environment: string;
  runStartedAt: string;
  runCompletedAt: string;
  date: string;
  artefacts: ManifestEntry[];
  gaps: GapRecord[];
  totals: { collected: number; gaps: number; planned: number; failures: number };
}

export interface ManifestEntry {
  controlId: string;
  controlGroup: string;
  s3Key: string;
  sha256: string;
  collectedAt: string;
  sizeBytes: number;
}

/** Schema for a single control in control-matrix.yaml */
export interface ControlEntry {
  id: string;
  group: string;
  description: string;
  slo_description: string;
  evidence_source: string;
  status: "operating" | "planned" | "deprecated";
}

export interface ControlMatrix {
  schema_version: string;
  control_groups: Array<{ id: string; name: string }>;
  controls: ControlEntry[];
}
