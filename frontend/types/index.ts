/**
 * Presentational and component-prop types for the web app.
 *
 * IMPORTANT: This file must NEVER declare any platform request, response,
 * event, or enum shape. Those live exclusively in @travel/contracts.
 * The only permitted content here is purely UI-level types that have no
 * overlap with the contracts domain: component prop shapes that compose
 * contracts types with visual state, UI-only enumerations (e.g. tab state),
 * and helper types for rendering logic.
 *
 * If you find yourself copy-pasting a field from a contracts type, stop —
 * import and compose the contracts type instead.
 */

import type { Offer } from "@travel/contracts";
import type { ErrorEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Offer display state (enriches the wire shape with derived UI state)
// ---------------------------------------------------------------------------

/** Derived bookability state computed by offer-guard.ts. */
export type BookabilityState =
  | { bookable: true }
  | { bookable: false; reason: "ILLUSTRATIVE" | "EXPIRED" };

/** Props consumed by the OfferCard component. */
export interface OfferCardProps {
  offer: Offer;
  bookability: BookabilityState;
  onBook: (offer: Offer) => void;
}

// ---------------------------------------------------------------------------
// Form error state (wraps envelope field mapping for React forms)
// ---------------------------------------------------------------------------

/** A form-level error state produced by the error-mapper. */
export interface FormErrorState {
  /** Per-field error messages keyed by the form field name. */
  fieldErrors: Record<string, string>;
  /** Form-level banner message when the envelope field has no form match. */
  formError: string | undefined;
  /** Support reference; rendered in the error boundary / banner. */
  reference: string;
}

// ---------------------------------------------------------------------------
// API result — discriminated union surfaced to UI components
// ---------------------------------------------------------------------------

/** Successful API call; data is the validated contracts response type. */
export type ApiSuccess<T> = {
  readonly ok: true;
  readonly data: T;
  readonly status: number;
};

/** Failed API call; error is the standard error envelope. */
export type ApiError = {
  readonly ok: false;
  readonly error: ErrorEnvelope;
  readonly status: number;
};

/** Union returned by every apiGet / apiPost call. */
export type ApiResult<T> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Search tab state (purely presentational)
// ---------------------------------------------------------------------------

export type SearchTab = "FLIGHT" | "HOTEL" | "CAR";

// ---------------------------------------------------------------------------
// Freshness display (derived from Offer.freshness + expiresAt)
// ---------------------------------------------------------------------------

export interface FreshnessDisplay {
  label: string;
  stale: boolean;
  expiresAt: Date;
}
