/**
 * gating.ts — pure gating decision for illustrative offer generation.
 *
 * All inputs are plain values so this function is exhaustively testable
 * without any I/O dependencies. The matrix is:
 *
 *   hardDisabled │ flagEnabled │ supplierUnavailable │ decision
 *   ─────────────┼─────────────┼─────────────────────┼──────────
 *   true         │ any         │ any                 │ suppress (hard_disabled)
 *   false        │ false       │ any                 │ suppress (flag_disabled)
 *   false        │ true        │ false               │ suppress (suppliers_available)
 *   false        │ true        │ true                │ allow
 *
 * Only the last row allows the generator to produce offers.  The caller is
 * responsible for checking supplierWasUnavailable (i.e. the fan-out result);
 * the generator's searchOffers() enforces the flag and hard-disable as a
 * second layer of defence in depth.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuppressReason =
  | 'hard_disabled'
  | 'flag_disabled'
  | 'suppliers_available';

export type GatingDecision =
  | { readonly decision: 'allow'; readonly reason: 'flag_enabled_and_supplier_unavailable' }
  | { readonly decision: 'suppress'; readonly reason: SuppressReason };

export interface GatingInput {
  /** The current deployment environment. */
  readonly environment: string;
  /** Environments for which production is always disabled regardless of flag. */
  readonly hardDisabledEnvironments: ReadonlyArray<string>;
  /** Whether the feature flag is currently enabled for this environment. */
  readonly flagEnabled: boolean;
  /** Whether at least one real supplier was unavailable for this request. */
  readonly supplierWasUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the illustrative generator should be invoked.
 *
 * This is a pure function with no side effects, suitable for exhaustive
 * matrix testing.  It must be called by the search fan-out before invoking
 * the generator; the generator also re-checks the flag internally as
 * defence in depth.
 */
export function evaluateGating(input: GatingInput): GatingDecision {
  if (input.hardDisabledEnvironments.includes(input.environment)) {
    return { decision: 'suppress', reason: 'hard_disabled' };
  }

  if (!input.flagEnabled) {
    return { decision: 'suppress', reason: 'flag_disabled' };
  }

  if (!input.supplierWasUnavailable) {
    return { decision: 'suppress', reason: 'suppliers_available' };
  }

  return { decision: 'allow', reason: 'flag_enabled_and_supplier_unavailable' };
}
