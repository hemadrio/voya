/**
 * Versioned price table for Anthropic Claude models (WO-107).
 *
 * Rules:
 *  - Prices are stored as USD per million tokens (input / output separately).
 *  - Multiple entries per model are allowed; the entry with the greatest
 *    effectiveFrom that is ≤ the record's occurredAt is used.
 *  - Prices are never fetched from a live API — they are checked in here so
 *    historical cost records recompute deterministically.
 *  - An unknown model identifier raises an explicit error (PriceLookupError)
 *    and increments the price-table-miss metric.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelPriceEntry {
  /** Anthropic model identifier, e.g. "claude-sonnet-4-6". */
  model: string;
  /** Input token price in USD per million tokens. */
  inputPricePerMToken: number;
  /** Output token price in USD per million tokens. */
  outputPricePerMToken: number;
  /**
   * ISO 8601 date string.  The entry applies to cost records with
   * occurredAt >= effectiveFrom (and < the next entry's effectiveFrom).
   */
  effectiveFrom: string;
}

/** Human-readable version tag embedded in every cost record. */
export const PRICE_TABLE_VERSION = "2026-08-01";

// ---------------------------------------------------------------------------
// Price table — checked-in source of truth
// ---------------------------------------------------------------------------

const PRICE_TABLE: ModelPriceEntry[] = [
  // ---------------------------------------------------------------------------
  // Claude Haiku 4.5
  // ---------------------------------------------------------------------------
  {
    model: "claude-haiku-4-5-20251001",
    inputPricePerMToken: 0.80,
    outputPricePerMToken: 4.00,
    effectiveFrom: "2025-10-01",
  },

  // ---------------------------------------------------------------------------
  // Claude Sonnet 4.6 (production assistant model)
  // ---------------------------------------------------------------------------
  {
    model: "claude-sonnet-4-6",
    inputPricePerMToken: 3.00,
    outputPricePerMToken: 15.00,
    effectiveFrom: "2025-11-01",
  },
  // Anthropic short-form alias
  {
    model: "claude-sonnet-4-6-20251101",
    inputPricePerMToken: 3.00,
    outputPricePerMToken: 15.00,
    effectiveFrom: "2025-11-01",
  },

  // ---------------------------------------------------------------------------
  // Claude Sonnet 5
  // ---------------------------------------------------------------------------
  {
    model: "claude-sonnet-5",
    inputPricePerMToken: 3.00,
    outputPricePerMToken: 15.00,
    effectiveFrom: "2026-06-01",
  },
  {
    model: "claude-sonnet-5-20260601",
    inputPricePerMToken: 3.00,
    outputPricePerMToken: 15.00,
    effectiveFrom: "2026-06-01",
  },

  // ---------------------------------------------------------------------------
  // Claude Opus 5
  // ---------------------------------------------------------------------------
  {
    model: "claude-opus-5",
    inputPricePerMToken: 15.00,
    outputPricePerMToken: 75.00,
    effectiveFrom: "2026-06-01",
  },
  {
    model: "claude-opus-5-20260601",
    inputPricePerMToken: 15.00,
    outputPricePerMToken: 75.00,
    effectiveFrom: "2026-06-01",
  },

  // ---------------------------------------------------------------------------
  // Claude Fable 5 (coding-optimised)
  // ---------------------------------------------------------------------------
  {
    model: "claude-fable-5",
    inputPricePerMToken: 15.00,
    outputPricePerMToken: 75.00,
    effectiveFrom: "2026-06-01",
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export class PriceLookupError extends Error {
  constructor(
    readonly modelId: string,
    readonly occurredAt: string,
  ) {
    super(`Unknown model in price table: "${modelId}" at ${occurredAt}. Add an entry to priceTable.ts.`);
    this.name = "PriceLookupError";
  }
}

/**
 * Look up the active price entry for a model at a given point in time.
 *
 * Throws PriceLookupError if no entry is found for the model.
 * The caller is responsible for counting price-table-miss metrics.
 */
export function lookupPrice(modelId: string, occurredAt: Date): ModelPriceEntry {
  const isoDate = occurredAt.toISOString();

  // Filter to entries for this model with effectiveFrom <= occurredAt
  const candidates = PRICE_TABLE
    .filter((e) => e.model === modelId && e.effectiveFrom <= isoDate)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

  if (candidates.length === 0) {
    throw new PriceLookupError(modelId, isoDate);
  }
  return candidates[0];
}

/**
 * Compute cost in USD for a single model call.
 * Returns a number rounded to 6 decimal places for storage as NUMERIC(10,6).
 */
export function computeCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  occurredAt: Date,
): { costUsd: number; priceEntry: ModelPriceEntry } {
  const entry = lookupPrice(modelId, occurredAt);
  const costUsd =
    (inputTokens * entry.inputPricePerMToken + outputTokens * entry.outputPricePerMToken) /
    1_000_000;
  return { costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, priceEntry: entry };
}

/** Returns all model identifiers known to the price table. */
export function knownModels(): string[] {
  return [...new Set(PRICE_TABLE.map((e) => e.model))];
}
