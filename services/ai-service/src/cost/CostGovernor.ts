/**
 * CostGovernor — reconcile hook that persists a durable, PII-free cost record
 * after every assistant model call (WO-107, AC1).
 *
 * This is a pure domain service that sits on top of BudgetGuard and is called
 * from the ConversationOrchestrator reconcile step (after message_end).
 *
 * Constraints:
 *  - No prompt text, completion text, or traveler PII is written to cost records.
 *  - Store or publisher failures are caught and surfaced as a metering-degraded
 *    metric; they NEVER abort an assistant response or skip pre-call caps.
 *  - Unknown model identifiers log an error and count a price-table-miss metric
 *    rather than being priced at zero.
 */

import { computeCostUsd, PriceLookupError, PRICE_TABLE_VERSION } from "./priceTable.js";

// ---------------------------------------------------------------------------
// Cost record shape
// ---------------------------------------------------------------------------

/** PII-free record of a single completed assistant model call. */
export interface AssistantCostRecord {
  /** Conversation this call belongs to. Low-cardinality — never a CW dimension. */
  conversationId: string;
  /** Anthropic model identifier, e.g. "claude-sonnet-4-6". */
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  /** Computed cost in USD from the versioned price table. */
  costUsd: number;
  /** Identifier of the price table version used for this computation. */
  priceTableVersion: string;
  /** Wall-clock timestamp of the model call. */
  occurredAt: Date;
  /** Retention date — set to occurredAt + 2 years by default. */
  purgeAfter: Date;
}

// ---------------------------------------------------------------------------
// Store port — injected so domain layer has no DB dependency
// ---------------------------------------------------------------------------

export interface CostRecordStorePort {
  /** Persist a cost record.  Must be insert-only; never mutates existing rows. */
  insert(record: AssistantCostRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Metrics port
// ---------------------------------------------------------------------------

export interface CostGovernorMetricsPort {
  /** Increment a named counter. */
  increment(name: string, value?: number, labels?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// Cap breach tracking input
// ---------------------------------------------------------------------------

export interface TurnSummary {
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  occurredAt: Date;
  /** Whether this turn hit a hard budget cap. */
  capBreached: boolean;
  /** Which cap was breached, if any. */
  capKind?: string;
}

// ---------------------------------------------------------------------------
// RETENTION
// ---------------------------------------------------------------------------

const COST_RECORD_RETENTION_YEARS = 2;

function purgeAfter(occurredAt: Date): Date {
  const d = new Date(occurredAt);
  d.setFullYear(d.getFullYear() + COST_RECORD_RETENTION_YEARS);
  return d;
}

// ---------------------------------------------------------------------------
// CostGovernor
// ---------------------------------------------------------------------------

export class CostGovernor {
  constructor(
    private readonly store: CostRecordStorePort,
    private readonly metrics?: CostGovernorMetricsPort,
  ) {}

  /**
   * Reconcile: persist a durable cost record for a completed turn.
   *
   * MUST be called after every model call, including incomplete turns.
   * Failures are caught and metered; they never throw to the caller.
   */
  async reconcile(turn: TurnSummary): Promise<void> {
    // ---------------------------------------------------------------------------
    // Cap breach metric — AC5
    // ---------------------------------------------------------------------------
    if (turn.capBreached) {
      this.metrics?.increment("assistant.cap_breach", 1, {
        cap: turn.capKind ?? "unknown",
        model: turn.model,
      });
    }

    // ---------------------------------------------------------------------------
    // Cost computation — fail gracefully on unknown model
    // ---------------------------------------------------------------------------
    let costUsd: number;
    let priceTableVersion: string;

    try {
      const result = computeCostUsd(turn.model, turn.inputTokens, turn.outputTokens, turn.occurredAt);
      costUsd = result.costUsd;
      priceTableVersion = PRICE_TABLE_VERSION;
    } catch (err) {
      if (err instanceof PriceLookupError) {
        this.metrics?.increment("assistant.price_table_miss", 1, { model: turn.model });
      }
      this.metrics?.increment("assistant.metering_degraded", 1);
      // Do not re-throw — AC6: metering failure must not abort assistant response
      return;
    }

    // ---------------------------------------------------------------------------
    // Persist record — AC1, AC7 (no PII, no prompt/completion content)
    // ---------------------------------------------------------------------------
    const record: AssistantCostRecord = {
      conversationId: turn.conversationId,
      model: turn.model,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      toolCallCount: turn.toolCallCount,
      costUsd,
      priceTableVersion,
      occurredAt: turn.occurredAt,
      purgeAfter: purgeAfter(turn.occurredAt),
    };

    try {
      await this.store.insert(record);
    } catch (storeErr) {
      // AC6: store failure → metering-degraded metric, never abort response
      const msg = storeErr instanceof Error ? storeErr.message : String(storeErr);
      this.metrics?.increment("assistant.metering_degraded", 1);
      // Log without PII — only model identifier and a truncated error
      process.stderr.write(
        JSON.stringify({
          level: "error",
          event: "cost_record_store_failure",
          model: turn.model,
          error: msg.slice(0, 200),
        }) + "\n",
      );
    }
  }
}
