/**
 * StripeBalanceReaderPort — port for paginated Stripe balance transaction reads.
 *
 * The concrete adapter wraps the Stripe SDK; the test double (InMemoryStripeReader)
 * is used in unit and integration tests without any network or SDK dependency.
 *
 * Cursor strategy: Stripe uses `starting_after` (the last object ID seen).
 * The reader persists this cursor after each page so a crashed run resumes
 * from the right page rather than re-scanning from the beginning.
 */

import type { ProviderTransaction } from "./ReconciliationEngine.js";

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface StripeBalancePage {
  transactions: ProviderTransaction[];
  /** next starting_after cursor; null when this is the last page */
  nextCursor: string | null;
}

export interface StripeBalanceReaderPort {
  /**
   * Fetch one page of settled balance transactions for the given UTC date.
   *
   * @param periodDate    - UTC date to scope the query (YYYY-MM-DD)
   * @param startingAfter - Stripe object ID to start after (pagination cursor)
   * @param limit         - page size (max 100)
   */
  listPage(
    periodDate: string,
    startingAfter: string | null,
    limit: number,
  ): Promise<StripeBalancePage>;
}

// ---------------------------------------------------------------------------
// InMemoryStripeReader — test double
// ---------------------------------------------------------------------------

/** Simulates a Stripe balance transaction list with pre-seeded transactions. */
export class InMemoryStripeReader implements StripeBalanceReaderPort {
  private readonly _transactions: ProviderTransaction[];
  /** Track page calls for resumability tests */
  readonly pageCalls: Array<{ startingAfter: string | null; limit: number }> = [];

  constructor(transactions: ProviderTransaction[] = []) {
    this._transactions = [...transactions];
  }

  async listPage(
    _periodDate: string,
    startingAfter: string | null,
    limit: number,
  ): Promise<StripeBalancePage> {
    this.pageCalls.push({ startingAfter, limit });

    const startIdx = startingAfter
      ? this._transactions.findIndex((t) => t.id === startingAfter) + 1
      : 0;

    const page = this._transactions.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + limit < this._transactions.length;

    return {
      transactions: page,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
