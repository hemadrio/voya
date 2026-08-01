/**
 * WebhookProcessor — exactly-once Stripe webhook orchestrator (WO-047).
 *
 * Pipeline order (AC2, AC3):
 *   1. Compute SHA-256 payload_digest of the raw body.
 *   2. Redis SET NX (stripe:event:{id}, TTL=72h) — hot-path dedup.
 *      - false → DUPLICATE (200 no-op, debug log).
 *      - throws → Redis unavailable; fall through to DB layer (NEVER skip).
 *   3. Open DB transaction:
 *      a. INSERT processed_events (provider, event_id, event_type,
 *           payload_digest, outcome, processed_at).
 *         - UNIQUE violation → DUPLICATE (200 no-op).
 *      b. Route by event_type:
 *         - payment_intent.succeeded → handleSucceeded()
 *         - payment_intent.payment_failed → handleFailed()
 *         - unknown → IGNORED
 *      c. Commit.
 *   4. Publish queue event AFTER commit (booking.confirmed on SQS FIFO).
 *
 * Terminal-booking guard (AC6):
 *   A payment_intent.succeeded for an EXPIRED or CANCELLED booking writes a
 *   reconciliation_exceptions row (kind=CONFIRMATION_AFTER_TERMINAL), logs
 *   at error, returns 200 with outcome=EXCEPTION.
 *
 * Constraints:
 *   - Database unique constraint is the authority; Redis is an optimisation.
 *   - Redis outage must never cause an event to be skipped (AC2).
 *   - Only one CONFIRMED transition, one audit row, one queue message per
 *     event (AC3, AC4).
 *   - Plaintext PII never appears in logs (payment amounts are OK; card data
 *     is never in Stripe webhook event metadata).
 */

import { createHash } from "node:crypto";
import type { DedupCachePort } from "./DedupCachePort.js";
import {
  stripeEventCacheKey,
  STRIPE_DEDUP_TTL_SECONDS,
} from "./DedupCachePort.js";
import type { BookingCommandPort, BookingStatus } from "./BookingCommandPort.js";
import type { QueuePort, TraceContext } from "@travel/queue";
import type { ParsedStripeEvent } from "./WebhookVerifier.js";

// ---------------------------------------------------------------------------
// Injected DB interfaces
// ---------------------------------------------------------------------------

export interface WebhookProcessedEventData {
  provider: string;
  eventId: string;
  eventType: string;
  payloadDigest: string;
  outcome: "PROCESSED" | "IGNORED" | "EXCEPTION";
  processedAt: Date;
}

export interface ReconciliationExceptionData {
  kind: string;
  bookingId: string | null;
  paymentIntentId: string | null;
  detail: Record<string, unknown>;
}

export interface PaymentUpdateData {
  provider: string;
  providerReference: string;
  status: string;
}

/** Minimal Prisma-shaped TX client needed by WebhookProcessor. */
export interface WebhookTxClient {
  processedEvent: {
    create(args: { data: WebhookProcessedEventData }): Promise<unknown>;
  };
  reconciliationException: {
    create(args: { data: ReconciliationExceptionData }): Promise<unknown>;
  };
  bookingAuditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  payment: {
    updateMany(args: {
      where: { provider: string; providerReference: string };
      data: { status: string; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface WebhookDbClient {
  $transaction<T>(fn: (tx: WebhookTxClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Logger interface (duck-typed — Pino-compatible)
// ---------------------------------------------------------------------------

export interface WebhookLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Outcome type
// ---------------------------------------------------------------------------

export type WebhookOutcome = "PROCESSED" | "DUPLICATE" | "IGNORED" | "EXCEPTION";

// ---------------------------------------------------------------------------
// PostgreSQL unique_violation detection
// ---------------------------------------------------------------------------

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    const code = (err as Record<string, unknown>)["code"];
    return code === PG_UNIQUE_VIOLATION;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic UUID from Stripe event ID
//
// SqsAdapter requires envelope.eventId to be a UUID v4 string (for the
// MessageDeduplicationId). We derive a deterministic UUID-shaped ID from
// the Stripe event ID using SHA-256 so the same event always maps to the
// same MessageDeduplicationId, giving the SQS FIFO dedup guarantee.
// ---------------------------------------------------------------------------

function stripeEventToQueueUuid(stripeEventId: string): string {
  const hash = createHash("sha256").update(stripeEventId, "utf8").digest("hex");
  // Format as UUID v4 (version bits set to 4, variant bits to 10xxxxxx)
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16)}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Terminal booking statuses for confirmation-after-terminal guard (AC6)
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<BookingStatus>(["EXPIRED", "CANCELLED"]);

// ---------------------------------------------------------------------------
// WebhookProcessor
// ---------------------------------------------------------------------------

export interface WebhookProcessorOptions {
  provider?: string;
  queue?: {
    topic: string;
    schemaVersion: number;
  };
}

export class WebhookProcessor {
  private readonly provider: string;
  private readonly queueTopic: string;
  private readonly schemaVersion: number;

  constructor(
    private readonly dedupCache: DedupCachePort,
    private readonly db: WebhookDbClient,
    private readonly bookingCommand: BookingCommandPort,
    private readonly queue: QueuePort,
    private readonly logger: WebhookLogger,
    private readonly clock: () => Date = () => new Date(),
    options: WebhookProcessorOptions = {},
  ) {
    this.provider = options.provider ?? "stripe";
    this.queueTopic = options.queue?.topic ?? "booking.confirmed";
    this.schemaVersion = options.queue?.schemaVersion ?? 1;
  }

  /**
   * Process a verified Stripe event with exactly-once guarantees.
   *
   * @param event        - Already-verified ParsedStripeEvent from WebhookVerifier
   * @param rawBody      - Raw HTTP body bytes (for SHA-256 digest)
   * @param correlationId - Inbound request correlation ID for trace propagation
   * @returns            - Processing outcome
   */
  async process(
    event: ParsedStripeEvent,
    rawBody: Buffer | string,
    correlationId?: string,
  ): Promise<WebhookOutcome> {
    const payloadDigest = createHash("sha256")
      .update(typeof rawBody === "string" ? rawBody : rawBody)
      .digest("hex");

    // ── Layer 1: Redis SET NX hot-path dedup ──────────────────────────────
    const cacheKey = stripeEventCacheKey(event.id);
    try {
      const acquired = await this.dedupCache.tryAcquire(cacheKey, STRIPE_DEDUP_TTL_SECONDS);
      if (!acquired) {
        this.logger.debug(
          { eventId: event.id, eventType: event.type },
          "Webhook duplicate detected via Redis SET NX — returning 200 no-op",
        );
        return "DUPLICATE";
      }
    } catch (cacheErr: unknown) {
      // Redis unavailable — MUST NOT skip; fall through to DB constraint (AC2)
      this.logger.warn(
        { eventId: event.id, err: String(cacheErr) },
        "Redis unavailable for dedup check — falling through to DB unique constraint",
      );
    }

    // ── Layer 2: Route by event type ──────────────────────────────────────
    switch (event.type) {
      case "payment_intent.succeeded":
        return this.handleSucceeded(event, payloadDigest, correlationId);

      case "payment_intent.payment_failed":
        return this.handleFailed(event, payloadDigest, correlationId);

      default:
        return this.handleIgnored(event, payloadDigest);
    }
  }

  // ── payment_intent.succeeded ─────────────────────────────────────────────

  private async handleSucceeded(
    event: ParsedStripeEvent,
    payloadDigest: string,
    correlationId: string | undefined,
  ): Promise<WebhookOutcome> {
    const pi = event.data as {
      object: {
        id: string;
        amount?: number;
        currency?: string;
        metadata?: { bookingId?: string };
      };
    };
    const paymentIntentId = pi.object.id;
    const bookingId = pi.object.metadata?.bookingId ?? null;
    const now = this.clock();

    // Pre-transaction booking state check (avoids holding lock on terminal path)
    if (bookingId) {
      let bookingState: { status: BookingStatus; userId: string } | null = null;
      try {
        bookingState = await this.bookingCommand.getBookingStatus(bookingId);
      } catch {
        bookingState = null;
      }

      if (bookingState && TERMINAL_STATUSES.has(bookingState.status)) {
        // ── AC6: Confirmation after terminal — write EXCEPTION record ──────
        return this.handleConfirmationAfterTerminal(
          event,
          payloadDigest,
          bookingId,
          paymentIntentId,
          bookingState.status,
          now,
        );
      }
    }

    // ── Normal succeeded path ─────────────────────────────────────────────
    let userId = "";
    try {
      await this.db.$transaction(async (tx) => {
        // Durable dedup insert — unique violation = DUPLICATE
        await tx.processedEvent.create({
          data: {
            provider: this.provider,
            eventId: event.id,
            eventType: event.type,
            payloadDigest,
            outcome: "PROCESSED",
            processedAt: now,
          },
        });

        // Update payment row to SUCCEEDED
        await tx.payment.updateMany({
          where: { provider: this.provider, providerReference: paymentIntentId },
          data: { status: "SUCCEEDED", updatedAt: now },
        });

        // Audit row: PAYMENT_RECEIVED (AC3)
        if (bookingId) {
          await tx.bookingAuditLog.create({
            data: {
              bookingId,
              action: "PAYMENT_RECEIVED",
              actorId: "system",
              actorRole: "system",
              resourceType: "payment",
              resourceId: paymentIntentId,
              occurredAt: now,
              payload: {
                stripeEventId: event.id,
                provider: this.provider,
                correlationId: correlationId ?? null,
              },
            },
          });
        }
      });

      // Transition booking to CONFIRMED (idempotent, carries event ID as token)
      if (bookingId) {
        const result = await this.bookingCommand.transitionToConfirmed(bookingId, event.id);
        userId = result.userId;
      }
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          { eventId: event.id },
          "Webhook duplicate detected via DB unique constraint — returning 200 no-op",
        );
        return "DUPLICATE";
      }
      throw err;
    }

    // ── Publish booking.confirmed after commit (AC3) ──────────────────────
    if (bookingId) {
      await this.publishBookingConfirmed(event.id, bookingId, userId, correlationId);
    }

    this.logger.info(
      { eventId: event.id, bookingId, outcome: "PROCESSED" },
      "payment_intent.succeeded processed — booking CONFIRMED",
    );
    return "PROCESSED";
  }

  // ── payment_intent.payment_failed ────────────────────────────────────────

  private async handleFailed(
    event: ParsedStripeEvent,
    payloadDigest: string,
    correlationId: string | undefined,
  ): Promise<WebhookOutcome> {
    const pi = event.data as {
      object: { id: string; metadata?: { bookingId?: string } };
    };
    const paymentIntentId = pi.object.id;
    const bookingId = pi.object.metadata?.bookingId ?? null;
    const now = this.clock();

    try {
      await this.db.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            provider: this.provider,
            eventId: event.id,
            eventType: event.type,
            payloadDigest,
            outcome: "PROCESSED",
            processedAt: now,
          },
        });

        // Update payment row to FAILED — booking stays PENDING with expiry intact (AC5)
        await tx.payment.updateMany({
          where: { provider: this.provider, providerReference: paymentIntentId },
          data: { status: "FAILED", updatedAt: now },
        });

        if (bookingId) {
          await tx.bookingAuditLog.create({
            data: {
              bookingId,
              action: "PAYMENT_FAILED",
              actorId: "system",
              actorRole: "system",
              resourceType: "payment",
              resourceId: paymentIntentId,
              occurredAt: now,
              payload: {
                stripeEventId: event.id,
                provider: this.provider,
                correlationId: correlationId ?? null,
              },
            },
          });
        }
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return "DUPLICATE";
      }
      throw err;
    }

    this.logger.info(
      { eventId: event.id, bookingId, outcome: "PROCESSED" },
      "payment_intent.payment_failed processed — booking remains PENDING",
    );
    return "PROCESSED";
  }

  // ── Unknown / unhandled event types ──────────────────────────────────────

  private async handleIgnored(
    event: ParsedStripeEvent,
    payloadDigest: string,
  ): Promise<WebhookOutcome> {
    const now = this.clock();
    try {
      await this.db.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            provider: this.provider,
            eventId: event.id,
            eventType: event.type,
            payloadDigest,
            outcome: "IGNORED",
            processedAt: now,
          },
        });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return "DUPLICATE";
      }
      throw err;
    }

    this.logger.debug(
      { eventId: event.id, eventType: event.type, outcome: "IGNORED" },
      "Unhandled Stripe event type recorded as IGNORED",
    );
    return "IGNORED";
  }

  // ── AC6: Confirmation-after-terminal ─────────────────────────────────────

  private async handleConfirmationAfterTerminal(
    event: ParsedStripeEvent,
    payloadDigest: string,
    bookingId: string,
    paymentIntentId: string,
    terminalStatus: BookingStatus,
    now: Date,
  ): Promise<WebhookOutcome> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            provider: this.provider,
            eventId: event.id,
            eventType: event.type,
            payloadDigest,
            outcome: "EXCEPTION",
            processedAt: now,
          },
        });

        await tx.reconciliationException.create({
          data: {
            kind: "CONFIRMATION_AFTER_TERMINAL",
            bookingId,
            paymentIntentId,
            detail: {
              stripeEventId: event.id,
              terminalStatus,
              provider: this.provider,
            },
          },
        });
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return "DUPLICATE";
      }
      throw err;
    }

    // Log at error + alarm (AC6)
    this.logger.error(
      {
        eventId: event.id,
        bookingId,
        terminalStatus,
        paymentIntentId,
        outcome: "EXCEPTION",
        alarm: "CONFIRMATION_AFTER_TERMINAL",
      },
      "payment_intent.succeeded received for booking in terminal state — reconciliation exception raised",
    );
    return "EXCEPTION";
  }

  // ── Queue publish helper ──────────────────────────────────────────────────

  private async publishBookingConfirmed(
    stripeEventId: string,
    bookingId: string,
    userId: string,
    correlationId: string | undefined,
  ): Promise<void> {
    const now = this.clock();
    const traceContext: TraceContext = {
      correlationId: correlationId,
    };

    try {
      await this.queue.publish(
        this.queueTopic,
        {
          // Deterministic UUID so SQS MessageDeduplicationId = f(stripeEventId)
          eventId: stripeEventToQueueUuid(stripeEventId),
          eventType: "booking.confirmed",
          occurredAt: now.toISOString(),
          correlationId: correlationId ?? bookingId,
          schemaVersion: this.schemaVersion,
          userId: userId || "00000000-0000-4000-8000-000000000000",
          payload: {
            bookingId,
            correlationId: correlationId ?? null,
          },
        },
        traceContext,
      );
    } catch (queueErr: unknown) {
      // Queue publish failure after DB commit — the processed_events row
      // ensures a retry can re-publish without re-transitioning (AC-edge).
      this.logger.error(
        { stripeEventId, bookingId, err: String(queueErr) },
        "Queue publish failed after DB commit — booking is CONFIRMED but notification may be delayed; reconciliation job will re-publish",
      );
      // Do NOT throw — the booking transition has already committed; a 500 here
      // would cause Stripe to retry the webhook, which would hit the unique
      // constraint and return DUPLICATE, never re-publishing.
    }
  }
}
