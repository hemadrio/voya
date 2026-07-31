/**
 * AuditWriter — writes a sanitised audit row inside the same transaction as
 * the booking state transition so the audit entry and the state change are
 * committed or rolled back atomically.
 *
 * Injectable: depends only on duck-typed interfaces so this module does not
 * pull in Prisma or any logger directly.  Callers wire in a real Prisma tx
 * client (or a test double) at call time.
 */

import { toSanitisedPayload } from "@travel/contracts/booking";
import type { SanitisedPayload } from "@travel/contracts/booking";

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

/** Subset of Prisma.BookingAuditLogCreateInput sufficient for WO-072 columns. */
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
 * Passing this interface (rather than the full PrismaClient) keeps the
 * domain layer free of the `@prisma/client` runtime dependency.
 */
export interface AuditTxClient {
  bookingAuditLog: {
    create(args: { data: AuditLogRow }): Promise<unknown>;
  };
}

/** Minimal structured-logger interface (mirrors the pino subset used elsewhere). */
export interface AuditLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// AuditWriter
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
  /** Raw snapshot — will be sanitised before persisting. */
  payload: unknown;
}

/**
 * Sanitise `payload` with `toSanitisedPayload`, then create the audit log row
 * using the supplied Prisma transaction client.
 *
 * Must be called inside an open Prisma interactive transaction so the audit row
 * is committed or rolled back with the parent state change.
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
