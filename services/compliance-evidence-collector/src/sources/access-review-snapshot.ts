/**
 * AccessReviewSnapshot — daily snapshot of IAM roles and application role assignments.
 *
 * Evidence payload: counts of principals per role, not the actual identifiers.
 * No email addresses, no usernames — only counts and role names.
 */

import type { EvidenceSource, EvidenceResult } from "../types.js";
import { EvidenceSourceError } from "../types.js";

export interface AccessReviewDeps {
  /** Returns a summary of application role assignments (counts per role, not actor IDs). */
  fetchRoleSummary(): Promise<Array<{ role: string; principalCount: number }>>;
  /** Returns IAM role names currently in the account (no ARNs in the payload). */
  fetchIamRoleNames(): Promise<string[]>;
}

export class AccessReviewSnapshot implements EvidenceSource {
  readonly name = "access_review_snapshot";

  constructor(private readonly deps: AccessReviewDeps) {}

  async gather(date: Date, runId: string, controlId: string, controlGroup: string): Promise<EvidenceResult> {
    try {
      const [appRoles, iamRoleNames] = await Promise.all([
        this.deps.fetchRoleSummary(),
        this.deps.fetchIamRoleNames(),
      ]);

      return {
        kind: "evidence",
        controlId, controlGroup,
        evidenceSource: this.name,
        collectedAt: new Date().toISOString(),
        runId,
        period: { date: date.toISOString().slice(0, 10) },
        data: {
          applicationRoles: appRoles,
          iamRoleCount: iamRoleNames.length,
          iamRoles: iamRoleNames,
          snapshotAt: date.toISOString().slice(0, 10),
        },
      };
    } catch (err) {
      throw new EvidenceSourceError(controlId, "access_review_failed", err);
    }
  }
}
