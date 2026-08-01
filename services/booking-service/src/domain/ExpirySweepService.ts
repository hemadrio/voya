/**
 * ExpirySweepService — domain logic for the PENDING booking expiry sweep.
 *
 * Responsibilities:
 *   1. Accept a pre-fetched batch of PENDING candidate rows.
 *   2. For each candidate, check the Stripe PaymentIntent status via
 *      PaymentStatusPort. Skip any booking whose intent is non-terminal.
 *   3. Transition safe candidates to EXPIRED via BookingLifecycleService,
 *      which writes the audit row inside the same transaction.
 *   4. Publish a booking.expired queue event for each successful transition.
 *   5. Return structured SweepRunResult for metric emission and alarming.
 *
 * Concurrency safety:
 *   The candidate query uses FOR UPDATE SKIP LOCKED at the DB level so two
 *   sweep processes over the same batch never contend.  BookingLifecycleService
 *   performs an additional conditional UPDATE (WHERE status = 'PENDING') so a
 *   race between a sweep and a legitimate webhook confirms exactly one winner.
 *
 * Error isolation:
 *   Per-item failures are caught and counted. The overall batch does not abort.
 *   The caller receives the failure count and can decide whether to exit non-zero.
 */

import { randomUUID } from "node:crypto";
import type { BookingLifecycleService } from "./BookingLifecycleService.js";
import type { PaymentStatusPort } from "./PaymentStatusPort.js";
import { isNonTerminalIntentStatus } from "./PaymentStatusPort.js";
import type { QueuePort } from "@travel/queue";
import type { QueueMessageEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Injectable types
// ---------------------------------------------------------------------------

export interface SweepCandidate {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SweepMetrics {
  candidates: number;
  expired: number;
  skipped: number;
  failed: number;
  durationMs: number;
}

export interface SweepRunResult {
  correlationId: string;
  metrics: SweepMetrics;
  /** Individual per-item failures. Never contains PII beyond bookingId. */
  itemErrors: Array<{ bookingId: string; reason: string }>;
}

export interface SweepLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ExpirySweepDeps {
  lifecycleService: BookingLifecycleService;
  paymentStatus: PaymentStatusPort;
  queue: QueuePort;
  clock?: () => Date;
  log?: SweepLogger;
}

// ---------------------------------------------------------------------------
// SYSTEM actor constant
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR = { id: "system", role: "system" } as const;
const ABANDONED_REASON = "ABANDONED_CHECKOUT";
const SWEEP_QUEUE_TOPIC = "booking.expired";

// ---------------------------------------------------------------------------
// ExpirySweepService
// ---------------------------------------------------------------------------

export class ExpirySweepService {
  private readonly lifecycleService: BookingLifecycleService;
  private readonly paymentStatus: PaymentStatusPort;
  private readonly queue: QueuePort;
  private readonly clock: () => Date;
  private readonly log: SweepLogger | undefined;

  constructor(deps: ExpirySweepDeps) {
    this.lifecycleService = deps.lifecycleService;
    this.paymentStatus = deps.paymentStatus;
    this.queue = deps.queue;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  /**
   * Process a single pre-fetched batch of PENDING candidates.
   *
   * @param candidates - Rows returned by the repository SKIP LOCKED query.
   * @param correlationId - Trace ID for this sweep run.
   */
  async processBatch(
    candidates: SweepCandidate[],
    correlationId: string,
  ): Promise<SweepRunResult> {
    const startMs = Date.now();
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    const itemErrors: Array<{ bookingId: string; reason: string }> = [];

    for (const candidate of candidates) {
      try {
        const intentStatus = await this.paymentStatus.getIntentStatus(candidate.id);

        if (intentStatus && isNonTerminalIntentStatus(intentStatus.status)) {
          this.log?.warn(
            {
              bookingId: candidate.id,
              intentId: intentStatus.intentId,
              intentStatus: intentStatus.status,
              correlationId,
            },
            "Expiry sweep skipped — PaymentIntent in non-terminal state",
          );
          skipped++;
          continue;
        }

        const now = this.clock();

        await this.lifecycleService.transition(
          candidate.id,
          "EXPIRED",
          SYSTEM_ACTOR,
          ABANDONED_REASON,
        );

        // Publish booking.expired domain event for compensation/notification consumers
        const envelope: QueueMessageEnvelope = {
          eventId: randomUUID(),
          eventType: "booking.expired",
          occurredAt: now.toISOString(),
          correlationId,
          schemaVersion: 1,
          userId: candidate.userId,
          payload: {
            bookingId: candidate.id,
            expiredAt: now.toISOString(),
            correlationId,
          },
        };

        await this.queue.publish(SWEEP_QUEUE_TOPIC, envelope);

        this.log?.info(
          { bookingId: candidate.id, correlationId },
          "Booking expired by sweep",
        );

        expired++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log?.error(
          { bookingId: candidate.id, reason, correlationId },
          "Expiry sweep item failed",
        );
        itemErrors.push({ bookingId: candidate.id, reason });
        failed++;
      }
    }

    const durationMs = Date.now() - startMs;

    return {
      correlationId,
      metrics: {
        candidates: candidates.length,
        expired,
        skipped,
        failed,
        durationMs,
      },
      itemErrors,
    };
  }
}
