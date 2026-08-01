/**
 * AuditWriter — writes a sanitised audit row inside the same transaction as
 * the payment operation so the audit entry and the ledger change are committed
 * or rolled back atomically.
 *
 * Mirrors the interface in booking-service/src/domain/AuditWriter.ts so the
 * two services share the same booking_audit_log table (one append-only log for
 * the whole booking lifecycle) without coupling their codebases.
 *
 * Injectable: depends only on duck-typed interfaces — no Prisma, no logger.
 */

import { toSanitisedPayload } from "@travel/contracts/booking";
import type { SanitisedPayload } from "@travel/contracts/booking";

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

/** Subset of Prisma.BookingAuditLogCreateInput used by the payment service. */
export interface AuditLogRow {
  bookingId: string;
  action: string;
  actorId: string;
  actorRole: string;
  resourceType: string;
  resourceId: string;
  occurredAt: Date;
  payload: unknown;
}

/**
 * Minimal Prisma-compatible transaction client slice.
 *
 * The concrete implementation casts the Prisma interactive-transaction client
 * to this interface.  Unit-test doubles implement it directly without Prisma.
 */
export interface AuditTxClient {
  bookingAuditLog: {
    create(args: { data: AuditLogRow }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// writeAudit
// ---------------------------------------------------------------------------

export interface WriteAuditParams {
  tx: AuditTxClient;
  bookingId: string;
  action: string;
  actorId: string;
  actorRole: string;
  resourceType: string;
  resourceId: string;
  occurredAt: Date;
  /** Raw snapshot — sanitised before persisting (PII fields stripped). */
  payload: unknown;
}

/**
 * Sanitise `payload` through `toSanitisedPayload`, then insert the audit row
 * using the supplied Prisma transaction client.
 *
 * Must be called inside an open Prisma interactive transaction so the audit
 * row is committed or rolled back together with the parent payment operation.
 */
export async function writeAudit(params: WriteAuditParams): Promise<SanitisedPayload> {
  const sanitised = toSanitisedPayload(params.payload);

  await params.tx.bookingAuditLog.create({
    data: {
      bookingId: params.bookingId,
      action: params.action,
      actorId: params.actorId,
      actorRole: params.actorRole,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      occurredAt: params.occurredAt,
      payload: sanitised,
    },
  });

  return sanitised;
}
