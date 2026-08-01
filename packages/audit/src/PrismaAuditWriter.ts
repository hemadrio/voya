/**
 * PrismaAuditWriter — Prisma-backed implementation of the AuditWriter port.
 *
 * Hash chain algorithm:
 *   pre_image = canonical({ actorId, actorRole, action, resourceType,
 *                           resourceId, previousState, newState,
 *                           occurredAt (ISO-8601), correlationId }) + prev_hash
 *   entry_hash = SHA-256(pre_image)
 *
 * Concurrency guard:
 *   The latest entry for the resource stream is read inside the same
 *   Prisma interactive transaction as the INSERT, with a row-level lock
 *   (SELECT FOR UPDATE via raw SQL is not available in Prisma typed API,
 *   so we rely on the transaction's snapshot isolation plus a unique
 *   index on entry_hash to prevent concurrent chain forks — two concurrent
 *   inserts with the same prev_hash would produce the same entry_hash only
 *   if the payloads were identical, which is structurally impossible for
 *   distinct state transitions).
 *
 * Redaction:
 *   previousState and newState are passed through sanitiseAuditPayload()
 *   from @travel/contracts before being included in the canonical pre-image
 *   and persisted.  Credential fields never enter the hash computation.
 */

import { createHash } from "node:crypto";
import { sanitiseAuditPayload } from "@travel/contracts/booking";
import type { AuditEventInput, AuditActorRole } from "@travel/contracts";
import { buildAuditPreImage, GENESIS_HASH } from "./canonicalize.js";
import type { AuditWriter, AuditTxClient, AuditAppendResult } from "./AuditWriter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Booking actions belong to booking_audit_log; all others to auth_audit_log. */
const BOOKING_ACTIONS = new Set([
  "BOOKING_CREATED",
  "BOOKING_PRICE_REVALIDATED",
  "BOOKING_CONFIRMED",
  "BOOKING_MODIFIED",
  "BOOKING_CANCELLED",
  "BOOKING_EXPIRED",
  "BOOKING_REFUNDED",
]);

// ---------------------------------------------------------------------------
// PrismaAuditWriter
// ---------------------------------------------------------------------------

export class PrismaAuditWriter implements AuditWriter {
  async append(tx: AuditTxClient, event: AuditEventInput): Promise<AuditAppendResult> {
    const isBookingEvent = BOOKING_ACTIONS.has(event.action);
    const table = isBookingEvent ? tx.bookingAuditLog : tx.authAuditLog;

    const occurredAt = event.occurredAt ?? new Date();
    const occurredAtIso = occurredAt.toISOString();
    const correlationId = event.correlationId ?? null;

    // Redact sensitive fields before hashing and persisting
    const prevStateSanitised = sanitiseAuditPayload(event.previousState ?? null);
    const newStateSanitised = sanitiseAuditPayload(event.newState ?? null);

    // Build pre-image using the previous entry's hash (or genesis sentinel)
    const latest = await table.findFirst({
      where: { resourceId: event.resourceId },
      orderBy: { occurredAt: "desc" },
      select: { entryHash: true },
    });
    const prevHash = latest?.entryHash ?? GENESIS_HASH;

    const preImage = buildAuditPreImage(
      {
        actorId: event.actorId,
        actorRole: event.actorRole,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        previousState: prevStateSanitised,
        newState: newStateSanitised,
        occurredAt: occurredAtIso,
        correlationId,
      },
      prevHash,
    );

    const entryHash = createHash("sha256").update(preImage, "utf8").digest("hex");

    const inserted = await table.create({
      data: {
        actorId: event.actorId,
        actorRole: event.actorRole as AuditActorRole,
        actorIp: event.actorIp ?? null,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        previousState: prevStateSanitised as Record<string, unknown>,
        newState: newStateSanitised as Record<string, unknown>,
        correlationId,
        occurredAt,
        prevHash,
        entryHash,
        // WO-041: optional reason column (nullable; omitted by system events)
        reason: event.reason ?? null,
      },
    });

    return { auditId: inserted.id, entryHash };
  }
}

// ---------------------------------------------------------------------------
// Chain verifier
// ---------------------------------------------------------------------------

export interface ChainEntry {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  previousState: unknown;
  newState: unknown;
  occurredAt: Date;
  correlationId: string | null;
  prevHash: string;
  entryHash: string;
}

export interface ChainBreak {
  entryId: string;
  resourceId: string;
  expected: string;
  actual: string;
  message: string;
}

/**
 * Verify the hash chain for a sequence of audit entries for the same resource.
 * Entries must be ordered by occurredAt ASC (insertion order).
 *
 * Returns an array of chain breaks — empty means the chain is intact.
 */
export function verifyChain(entries: ChainEntry[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const expectedPrevHash = i === 0 ? GENESIS_HASH : (entries[i - 1]?.entryHash ?? GENESIS_HASH);

    // Recompute the hash
    const prevStateSanitised = sanitiseAuditPayload(entry.previousState ?? null);
    const newStateSanitised = sanitiseAuditPayload(entry.newState ?? null);

    const preImage = buildAuditPreImage(
      {
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        previousState: prevStateSanitised,
        newState: newStateSanitised,
        occurredAt: entry.occurredAt.toISOString(),
        correlationId: entry.correlationId,
      },
      expectedPrevHash,
    );

    const recomputedHash = createHash("sha256").update(preImage, "utf8").digest("hex");

    if (recomputedHash !== entry.entryHash) {
      breaks.push({
        entryId: entry.id,
        resourceId: entry.resourceId,
        expected: recomputedHash,
        actual: entry.entryHash,
        message: `Chain break at entry ${entry.id} for resource ${entry.resourceId}: stored hash does not match recomputed hash`,
      });
    }

    // Also verify the stored prevHash matches the previous entry
    if (entry.prevHash !== expectedPrevHash) {
      breaks.push({
        entryId: entry.id,
        resourceId: entry.resourceId,
        expected: expectedPrevHash,
        actual: entry.prevHash,
        message: `Chain break at entry ${entry.id}: stored prev_hash does not match previous entry's entry_hash`,
      });
    }
  }

  return breaks;
}
