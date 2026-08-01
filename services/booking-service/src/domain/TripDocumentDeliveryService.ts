/**
 * TripDocumentDeliveryService — async document email delivery (WO-055).
 *
 * Responsibilities:
 *   1. Ownership predicate check (404 → 403 + security audit DENY).
 *   2. At-least-one-CONFIRMED precondition (409 if unmet).
 *   3. Recipient resolved server-side from authenticated user's verified email.
 *   4. Deterministic event ID from itineraryId + 5-minute time bucket (dedup window).
 *   5. Publish QueueMessageEnvelope with eventType "itinerary.document.requested".
 *   6. Audit ACCEPTED row written ONLY after successful publish (AC9).
 *   7. DENIED audit row on ownership failure.
 *
 * Framework-free: no Express, no Prisma, no AWS SDK imports here.
 * All dependencies are injected via constructor.
 *
 * Security:
 *   - Recipient email is NEVER included in the published payload (AC5).
 *   - No client-supplied recipient field is accepted.
 *   - Publish failure leaves no ACCEPTED audit row (AC9).
 */

import { createHash, randomUUID } from "node:crypto";
import { notFound, forbidden, conflict } from "@travel/contracts/errors";
import type { AuditTxClient } from "./AuditWriter.js";
import { writeAudit } from "./AuditWriter.js";
import type { SecurityEventWriter } from "./SecurityEventWriter.js";
import type { QueuePort } from "@travel/queue";
import type { QueueMessageEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Repository port — minimal slice needed by the delivery service
// ---------------------------------------------------------------------------

/** Minimal itinerary booking row for precondition checks. */
export interface ItineraryBookingStatusRow {
  status: string;
}

/** Minimal persistence port for the delivery service. */
export interface TripDocumentDeliveryRepositoryPort {
  /** Fetch itinerary existence without ownership filter (for 404-vs-403). */
  findItineraryById(itineraryId: string): Promise<{ id: string; userId: string } | null>;
  /**
   * Fetch booking statuses for an itinerary, scoped to the owner.
   * Returns empty array if the itinerary has no bookings or is not found for this user.
   */
  findItineraryBookingStatuses(
    itineraryId: string,
    userId: string,
  ): Promise<ItineraryBookingStatusRow[]>;
  /** Audit tx client for append-only audit rows. */
  auditTxClient: AuditTxClient;
}

// ---------------------------------------------------------------------------
// User email port
// ---------------------------------------------------------------------------

/** Minimal port for resolving the authenticated user's verified email. */
export interface UserEmailRepositoryPort {
  /**
   * Fetch the user's email and verification status.
   * Returns null when the user does not exist.
   */
  findUserVerifiedEmail(
    userId: string,
  ): Promise<{ email: string; emailVerified: boolean } | null>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SendDocumentResult {
  requestId: string;
  eventId: string;
  status: "QUEUED";
  reference?: string;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface DeliveryServiceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// TripDocumentDeliveryService
// ---------------------------------------------------------------------------

/** FIFO dedup window: 5 minutes in milliseconds (matches SQS FIFO dedup window). */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export class TripDocumentDeliveryService {
  constructor(
    private readonly repo: TripDocumentDeliveryRepositoryPort,
    private readonly userEmailRepo: UserEmailRepositoryPort,
    private readonly queue: QueuePort,
    private readonly securityWriter: SecurityEventWriter,
    private readonly clock: () => Date = () => new Date(),
    private readonly log?: DeliveryServiceLogger,
  ) {}

  /**
   * Request async delivery of an itinerary document email.
   *
   * Flow:
   *   1. Existence check (404)
   *   2. Ownership check (403 + DENIED audit)
   *   3. CONFIRMED precondition (409)
   *   4. User verified email (409 if absent)
   *   5. Build deterministic eventId
   *   6. Publish event to queue
   *   7. Write ACCEPTED audit (only after successful publish)
   *   8. Return result
   */
  async requestDocumentSend(
    itineraryId: string,
    userId: string,
    actor: { id: string; role: string },
    correlationId: string,
    locale: string = "en",
  ): Promise<SendDocumentResult> {
    const now = this.clock();

    // ── 1. Existence check (404) ─────────────────────────────────────────────
    const bare = await this.repo.findItineraryById(itineraryId);
    if (!bare) {
      throw notFound("Itinerary not found");
    }

    // ── 2. Ownership check (403 + DENIED audit) ──────────────────────────────
    if (bare.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: itineraryId,
        operation: "SEND_DOCUMENT",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      await writeAudit({
        tx: this.repo.auditTxClient,
        bookingId: itineraryId,
        action: "DOCUMENT_SEND_DENIED",
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: itineraryId,
        occurredAt: now,
        payload: { itineraryId, correlationId, reason: "OWNERSHIP_PREDICATE_FAILED" },
      });
      throw forbidden("Access denied to itinerary");
    }

    // ── 3. At-least-one-CONFIRMED precondition ───────────────────────────────
    const bookings = await this.repo.findItineraryBookingStatuses(itineraryId, userId);
    const confirmedCount = bookings.filter((b) => b.status === "CONFIRMED").length;
    if (confirmedCount === 0) {
      throw conflict(
        "Cannot send a trip document: itinerary has no CONFIRMED bookings. " +
          "At least one booking must reach CONFIRMED status before a document can be sent.",
        "itineraryId",
      );
    }

    // ── 4. Resolve recipient email (server-side only — never from request) ───
    const userRecord = await this.userEmailRepo.findUserVerifiedEmail(userId);
    if (!userRecord || !userRecord.emailVerified) {
      throw conflict(
        "Cannot send a trip document: no verified email address on your account. " +
          "Please verify your email address before requesting a document send.",
        "email",
      );
    }
    // Email address is used for delivery but is NEVER included in the queue
    // payload (AC5) and is never logged.

    // ── 5. Build deterministic event ID (5-minute dedup window) ─────────────
    const timeBucket = Math.floor(now.getTime() / DEDUP_WINDOW_MS);
    const eventId = deriveEventId(itineraryId, timeBucket);
    const requestId = randomUUID();

    // ── 6. Build and publish the envelope ───────────────────────────────────
    const envelope: QueueMessageEnvelope = {
      eventId,
      eventType: "itinerary.document.requested",
      occurredAt: now.toISOString(),
      correlationId,
      schemaVersion: 1,
      userId,
      payload: {
        itineraryId,
        locale,
        // email address is deliberately absent from the payload (AC5)
      },
    };

    try {
      await this.queue.publish("itinerary.document.requested", envelope);
    } catch (err) {
      // Publish failure: log at error level (AC9), surface retryable error,
      // and do NOT write an ACCEPTED audit row.
      this.log?.error(
        {
          itineraryId,
          correlationId,
          actorId: actor.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to publish itinerary.document.requested event",
      );
      throw Object.assign(
        new Error("Failed to queue document send request. Please retry."),
        { code: "QUEUE_PUBLISH_FAILED", retryable: true, reference: correlationId },
      );
    }

    // ── 7. Write ACCEPTED audit row (only after successful publish) ──────────
    await writeAudit({
      tx: this.repo.auditTxClient,
      bookingId: itineraryId,
      action: "DOCUMENT_SEND_ACCEPTED",
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "itinerary",
      resourceId: itineraryId,
      occurredAt: now,
      payload: {
        itineraryId,
        requestId,
        eventId,
        correlationId,
        locale,
        // email address is deliberately absent from the audit payload (AC5)
      },
    });

    this.log?.info(
      { itineraryId, requestId, eventId, correlationId, actorId: actor.id },
      "Trip document send queued successfully",
    );

    return { requestId, eventId, status: "QUEUED", reference: correlationId };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic UUID v4-formatted event ID from an itinerary ID and
 * a coarse time bucket.
 *
 * Repeated calls within the same 5-minute window return the same UUID, so
 * rapid duplicate requests reuse the same SQS FIFO MessageDeduplicationId
 * and the consumer's idempotency guard suppresses duplicate emails.
 *
 * The UUID v4 variant bits (version=4, variant=RFC 4122) are set on the
 * SHA-256 output to produce a spec-compliant UUID.
 */
export function deriveEventId(itineraryId: string, timeBucket: number): string {
  const hash = createHash("sha256")
    .update(`${itineraryId}:${timeBucket}`)
    .digest("hex");
  // Format as UUID v4: 8-4-4-4-12
  // Position 12 (group 3 first nibble) → version '4'
  // Position 16 (group 4 first nibble) → variant bits 10xx (0x8–0xb)
  const group3 = "4" + hash.slice(13, 16);
  const variantNibble = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const group4 = variantNibble + hash.slice(17, 20);
  return [hash.slice(0, 8), hash.slice(8, 12), group3, group4, hash.slice(20, 32)].join("-");
}
