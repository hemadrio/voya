/**
 * GDPR erasure pseudonymisation for booking_audit_log — WO-041.
 *
 * Audit rows must be RETAINED for at least one year (SOC 2 / compliance
 * requirement) and are therefore EXCLUDED from the GDPR purge job that
 * deletes personal data.  To satisfy the right-to-erasure obligation, the
 * actor reference is instead replaced with a stable, opaque surrogate:
 *
 *   surrogate = SHA-256(ACTOR_PSEUDONYM_SALT + actor_id) — hex digest
 *
 * Properties:
 *   - Stable: the same actor always maps to the same surrogate, so the
 *     trail remains internally consistent (entries for the same user are
 *     still grouped).
 *   - Opaque: no one holding only the surrogate can reverse it to the
 *     original actor_id without the site secret (ACTOR_PSEUDONYM_SALT).
 *   - Idempotent: running erasure twice leaves the row count unchanged.
 *   - State snapshots: previous_state / new_state are re-sanitised with
 *     sanitiseAuditPayload() to strip any residual PII that may have
 *     slipped through at write time (defence in depth).
 *
 * The actual UPDATE is performed by the database-level stored procedure
 * `pseudonymise_audit_actor` (installed by migration 0016) which runs
 * as SECURITY DEFINER so only the erasure_worker role can invoke it.
 * This layer provides the application-level interface: derive the
 * surrogate, call the procedure, return a count.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal tx/db client slice required by the pseudonymiser.
 * Injectable for testability — keeps the domain layer free of PrismaClient.
 */
export interface PseudonymiseTxClient {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PseudonymiseResult {
  /** The stable surrogate that replaced the actor_id. */
  surrogate: string;
  /** Number of booking_audit_log rows updated. */
  rowsUpdated: number;
}

// ---------------------------------------------------------------------------
// Surrogate derivation
// ---------------------------------------------------------------------------

/**
 * Derive the stable, opaque pseudonym for a given actor.
 *
 * Uses SHA-256(salt + actorId) so the mapping is:
 *   - Deterministic (same inputs → same output).
 *   - Non-reversible without the salt.
 *   - Consistent across all service instances sharing the same salt.
 *
 * @param actorId - The original actor UUID or principal name.
 * @param salt    - Site-specific secret (from env ACTOR_PSEUDONYM_SALT).
 */
export function deriveActorSurrogate(actorId: string, salt: string): string {
  if (!salt || salt.length < 16) {
    throw new Error(
      "ACTOR_PSEUDONYM_SALT must be at least 16 characters. " +
        "Set ACTOR_PSEUDONYM_SALT in the environment or secrets manager.",
    );
  }
  return createHash("sha256").update(salt + actorId, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pseudonymise — application-layer entry point
// ---------------------------------------------------------------------------

/**
 * Pseudonymise all booking_audit_log rows for the given actor.
 *
 * Must be called inside a privileged context (erasure_worker role) with a
 * transaction client that has EXECUTE permission on the stored procedure.
 *
 * @param tx      - Privileged transaction client (erasure_worker role).
 * @param actorId - The actor UUID to pseudonymise.
 * @param salt    - ACTOR_PSEUDONYM_SALT from the secrets store.
 */
export async function pseudonymiseAuditActor(
  tx: PseudonymiseTxClient,
  actorId: string,
  salt: string,
): Promise<PseudonymiseResult> {
  const surrogate = deriveActorSurrogate(actorId, salt);

  // Call the DB-level stored procedure installed by migration 0016.
  // SECURITY DEFINER ensures the UPDATE bypasses the INSERT-only app role
  // restriction — only the erasure_worker role can call this.
  const rowsUpdated = await tx.$executeRaw`
    SELECT pseudonymise_audit_actor(${actorId}::text, ${surrogate}::text)
  `;

  return { surrogate, rowsUpdated };
}
