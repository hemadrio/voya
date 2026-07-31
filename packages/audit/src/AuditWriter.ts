/**
 * AuditWriter port — WO-101.
 *
 * Domain services receive an AuditWriter by constructor injection.
 * They never import PrismaClient directly.
 *
 * Every `append` call MUST be made inside the same Prisma interactive
 * transaction as the state change it records, so a forced failure after
 * the state write rolls back both the state change and the audit row.
 */

import type { AuditEventInput } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Injectable transaction client slice
// ---------------------------------------------------------------------------

/**
 * Minimal Prisma transaction client slice required by PrismaAuditWriter.
 * Services inject the full tx client; this interface keeps the domain layer
 * free of the @prisma/client runtime dependency.
 */
export interface AuditTxClient {
  bookingAuditLog: {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      select: Record<string, boolean>;
    }): Promise<{ entryHash: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  authAuditLog: {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, string>;
      select: Record<string, boolean>;
    }): Promise<{ entryHash: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

// ---------------------------------------------------------------------------
// AuditWriter port
// ---------------------------------------------------------------------------

/**
 * Result of a successful audit append.
 */
export interface AuditAppendResult {
  /** The UUID of the newly inserted audit row. */
  auditId: string;
  /** The SHA-256 hash of this entry (for chain verification). */
  entryHash: string;
}

/**
 * Port interface that domain services depend on.
 * Implementations must never allow a successful state change to proceed
 * without a committed audit row — a failed append must throw, rolling back
 * the enclosing transaction.
 */
export interface AuditWriter {
  /**
   * Append an audit entry inside the supplied Prisma interactive transaction.
   *
   * @param tx    - The active Prisma transaction client (from prisma.$transaction).
   * @param event - The audit event to record.
   * @returns     - The inserted row's id and entry_hash.
   * @throws      - On any persistence failure; the caller's transaction is rolled back.
   */
  append(tx: AuditTxClient, event: AuditEventInput): Promise<AuditAppendResult>;
}
