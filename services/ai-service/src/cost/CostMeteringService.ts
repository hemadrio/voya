/**
 * CostMeteringService — attribution and metric publishing for assistant cost
 * governance (WO-107, AC2–AC6).
 *
 * Attribution rule (AC2):
 *   Conversation spend is attributed to a booking when the conversation's id
 *   appears on a booking that reached CONFIRMED within
 *   ASSISTANT_ATTRIBUTION_WINDOW_DAYS (default 7) of the conversation's last
 *   cost record.
 *
 * Metrics published (AC3):
 *   - assistant_cost_per_completed_booking_usd
 *   - assistant_spend_total_usd
 *   - assistant_spend_unattributed_usd
 *   - assistant_cap_breach_count
 *   - assistant_metering_heartbeat
 *
 * Constraints:
 *   - conversationId is NEVER a CloudWatch dimension (AC, Metric Dimensions).
 *   - Zero confirmed bookings → explicit no-data state, not 0 or Infinity.
 *   - Concurrent runs are guarded by an advisory lock (AC — concurrent scheduling).
 *   - Store/publisher failures emit metering_degraded and log; they never abort.
 */

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Aggregate cost data from the assistant_cost_record table. */
export interface CostRecordStore {
  /**
   * Return total cost (USD) and total cap-breach count for cost records
   * whose occurredAt falls within [windowStart, windowEnd).
   */
  sumCostInWindow(windowStart: Date, windowEnd: Date): Promise<{
    totalCostUsd: number;
    capBreachCount: number;
  }>;

  /**
   * Return total cost (USD) for cost records belonging to the given
   * conversationIds and whose occurredAt falls within [windowStart, windowEnd).
   */
  sumCostForConversations(
    conversationIds: string[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<number>;

  /**
   * Acquire a non-blocking advisory lock so concurrent scheduler instances
   * do not double-publish.  Returns true if the lock was acquired.
   * The lock is automatically released when the connection closes.
   */
  tryAcquireAdvisoryLock(lockKey: number): Promise<boolean>;
}

/** Look up bookings that reached CONFIRMED within the attribution window. */
export interface BookingLookupPort {
  /**
   * Return bookings that:
   *  - have status = CONFIRMED
   *  - have a non-null conversation_id
   *  - had their confirmed_at within [windowStart, windowEnd)
   */
  findConfirmedWithConversation(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Array<{ conversationId: string; confirmedAt: Date }>>;

  /**
   * Return the count of CONFIRMED bookings in [windowStart, windowEnd)
   * including those without a conversationId (form-based bookings).
   * Used as the denominator for the cost-per-booking ratio.
   * Excludes fully-refunded bookings.
   */
  countConfirmedBookings(windowStart: Date, windowEnd: Date): Promise<number>;
}

/** Publish a CloudWatch metric via EMF. */
export interface MetricPublisher {
  publish(
    name: string,
    value: number,
    unit: "None" | "Count" | "Milliseconds",
    dimensions?: Record<string, string>,
  ): void;
}

/** Injectable clock — makes tests deterministic. */
export type ClockFn = () => Date;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MeteringConfig {
  /**
   * Number of days to look back when joining conversation spend to
   * confirmed bookings.  Configurable via ASSISTANT_ATTRIBUTION_WINDOW_DAYS.
   * Default: 7.
   */
  attributionWindowDays: number;
  /**
   * Namespace prefix for all emitted metrics.
   * Default: "travel/assistant".
   */
  metricNamespace: string;
  /** Environment tag (low-cardinality). */
  environment: string;
  /** Model tag for attribution metrics (low-cardinality). */
  model: string;
  /** Advisory lock key for pg_try_advisory_lock. */
  advisoryLockKey: number;
}

const DEFAULT_CONFIG: MeteringConfig = {
  attributionWindowDays: 7,
  metricNamespace: "travel/assistant",
  environment: process.env.ENVIRONMENT ?? "unknown",
  model: process.env.AI_MODEL ?? "unknown",
  advisoryLockKey: 1234567890,
};

// ---------------------------------------------------------------------------
// CostMeteringService
// ---------------------------------------------------------------------------

export class CostMeteringService {
  private readonly config: MeteringConfig;

  constructor(
    private readonly costStore: CostRecordStore,
    private readonly bookingLookup: BookingLookupPort,
    private readonly publisher: MetricPublisher,
    private readonly clock: ClockFn = () => new Date(),
    config: Partial<MeteringConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Main entry point — called by the scheduled job
  // ---------------------------------------------------------------------------

  /**
   * Run the attribution pass and publish all metrics.
   *
   * Safe to call concurrently from multiple ECS tasks — an advisory lock
   * prevents double-publishing.
   */
  async runAttributionAndPublish(): Promise<void> {
    // Try to acquire advisory lock — skip if already held
    let lockAcquired = false;
    try {
      lockAcquired = await this.costStore.tryAcquireAdvisoryLock(this.config.advisoryLockKey);
    } catch {
      this.publishDegraded("advisory_lock_failure");
      return;
    }

    if (!lockAcquired) {
      // Another instance is running — skip silently
      return;
    }

    try {
      await this.doAttributionAndPublish();
    } catch (err) {
      this.publishDegraded("attribution_failure");
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "metering_attribution_failure",
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        }) + "\n",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Attribution and metric computation
  // ---------------------------------------------------------------------------

  private async doAttributionAndPublish(): Promise<void> {
    const now = this.clock();
    const windowEnd = now;
    const windowStart = this.subtractDays(now, this.config.attributionWindowDays);

    const dims = {
      environment: this.config.environment,
      model: this.config.model,
    };

    // --- 1. Total spend and cap breaches in window ---
    let totalResult: { totalCostUsd: number; capBreachCount: number };
    try {
      totalResult = await this.costStore.sumCostInWindow(windowStart, windowEnd);
    } catch {
      this.publishDegraded("cost_store_failure");
      return;
    }

    this.publisher.publish("assistant_spend_total_usd", totalResult.totalCostUsd, "None", dims);
    this.publisher.publish("assistant_cap_breach_count", totalResult.capBreachCount, "Count", dims);

    // --- 2. Confirmed bookings in window ---
    let confirmedWithConversation: Array<{ conversationId: string; confirmedAt: Date }>;
    let confirmedCount: number;
    try {
      [confirmedWithConversation, confirmedCount] = await Promise.all([
        this.bookingLookup.findConfirmedWithConversation(windowStart, windowEnd),
        this.bookingLookup.countConfirmedBookings(windowStart, windowEnd),
      ]);
    } catch {
      this.publishDegraded("booking_lookup_failure");
      return;
    }

    // --- 3. Attributed spend ---
    // Attribution rule (AC2): spend from conversations whose conversationId
    // appears on a CONFIRMED booking within the attribution window
    const attributedConversationIds = [
      ...new Set(confirmedWithConversation.map((b) => b.conversationId)),
    ];

    let attributedSpend = 0;
    if (attributedConversationIds.length > 0) {
      try {
        attributedSpend = await this.costStore.sumCostForConversations(
          attributedConversationIds,
          windowStart,
          windowEnd,
        );
      } catch {
        this.publishDegraded("cost_store_failure");
        return;
      }
    }

    const unattributedSpend = Math.max(0, totalResult.totalCostUsd - attributedSpend);
    this.publisher.publish("assistant_spend_unattributed_usd", unattributedSpend, "None", dims);

    // --- 4. Cost per completed booking ---
    // Zero confirmed bookings → emit no-data sentinel (-1) and stop.
    // The Terraform alarm uses treat_missing_data = notBreaching for this metric.
    if (confirmedCount === 0) {
      // Emit heartbeat to show the job ran, then stop ratio computation
      this.publisher.publish("assistant_metering_heartbeat", 1, "Count", dims);
      return;
    }

    const costPerBooking = attributedSpend / confirmedCount;
    this.publisher.publish(
      "assistant_cost_per_completed_booking_usd",
      costPerBooking,
      "None",
      dims,
    );

    // --- 5. Heartbeat (AC6 — absence triggers metering-degraded alarm) ---
    this.publisher.publish("assistant_metering_heartbeat", 1, "Count", dims);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private subtractDays(from: Date, days: number): Date {
    const d = new Date(from.getTime());
    d.setDate(d.getDate() - days);
    return d;
  }

  private publishDegraded(reason: string): void {
    try {
      this.publisher.publish("assistant_metering_degraded", 1, "Count", {
        environment: this.config.environment,
        reason,
      });
    } catch {
      // Best-effort — do not re-throw
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration factory (reads from environment variables)
// ---------------------------------------------------------------------------

export function loadMeteringConfig(): MeteringConfig {
  const windowDays = parseInt(process.env.ASSISTANT_ATTRIBUTION_WINDOW_DAYS ?? "7", 10);
  if (isNaN(windowDays) || windowDays < 1 || windowDays > 90) {
    throw new Error(
      `ASSISTANT_ATTRIBUTION_WINDOW_DAYS must be an integer between 1 and 90 (got "${process.env.ASSISTANT_ATTRIBUTION_WINDOW_DAYS}")`,
    );
  }
  return {
    attributionWindowDays: windowDays,
    metricNamespace: "travel/assistant",
    environment: process.env.ENVIRONMENT ?? "unknown",
    model: process.env.AI_MODEL ?? "unknown",
    advisoryLockKey: 1234567890,
  };
}
