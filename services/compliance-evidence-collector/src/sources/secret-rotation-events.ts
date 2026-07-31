/**
 * SecretRotationEvents — captures AWS Secrets Manager rotation events.
 *
 * Evidence: secretArn hashes (not values), rotation timestamps, ageAtRotationDays.
 * No secret values, no plaintext ARNs — hashed ARN identifiers only.
 */

import { createHash } from "node:crypto";
import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface RotationEvent {
  secretArnHash: string;    // sha256(secretArn) — not the ARN itself
  rotatedAt: string;
  previousRotationAt: string | null;
  ageAtRotationDays: number;
  rotationSuccess: boolean;
}

export interface SecretRotationEventsDeps {
  fetchRotationEvents(date: Date): Promise<RotationEvent[]>;
  /** Maximum allowed age in days before a secret is considered overdue. */
  maxAgePolicy: number;
}

/** Hash an ARN to avoid including it directly in evidence artefacts. */
export function hashArn(arn: string): string {
  return createHash("sha256").update(arn).digest("hex").slice(0, 16);
}

export class SecretRotationEvents implements EvidenceSource {
  readonly name = "secret_rotation_events";

  constructor(private readonly deps: SecretRotationEventsDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const events = await this.deps.fetchRotationEvents(date);

      if (events.length === 0) {
        return {
          kind: "gap",
          controlId, controlGroup,
          evidenceSource: this.name,
          collectedAt: new Date().toISOString(),
          runId,
          period: { date: date.toISOString().slice(0, 10) },
          reason: "no_data",
        };
      }

      const overdueCount = events.filter(
        (e) => e.ageAtRotationDays > this.deps.maxAgePolicy,
      ).length;

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          rotationEventsCount: events.length,
          successCount: events.filter((e) => e.rotationSuccess).length,
          failureCount: events.filter((e) => !e.rotationSuccess).length,
          overdueRotationsCount: overdueCount,
          maxAgePolicyDays: this.deps.maxAgePolicy,
          events: events.map((e) => ({
            secretArnHash: e.secretArnHash,
            rotatedAt: e.rotatedAt,
            ageAtRotationDays: e.ageAtRotationDays,
            rotationSuccess: e.rotationSuccess,
          })),
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "secret_rotation_failed", err);
    }
  }
}
