/**
 * Booking draft — stores validated date/guest selection + quote reference
 * so the checkout page receives a pre-validated handoff without re-entry
 * (WO-067).
 *
 * Extended in WO-068 to persist step data, completed steps, and draftId
 * so the checkout wizard can restore progress on refresh or back-navigation.
 *
 * Persisted to sessionStorage (client-only). No PII leaves the browser.
 */

"use client";

import type { TravelerDetailsValues, ExtrasValues, CheckoutStep } from "../validation/checkout.js";

// ---------------------------------------------------------------------------
// Draft shape
// ---------------------------------------------------------------------------

/** Step data collected during the wizard (partial until each step completes). */
export interface CheckoutStepData {
  traveler?: TravelerDetailsValues;
  extras?: ExtrasValues;
  promoCode?: string;
  priceChangeAcknowledged?: boolean;
}

export interface BookingDraft {
  // ---- Core quote/listing context (from WO-067) ----
  listingId: string;
  listingSlug: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  quoteId: string;
  quoteExpiresAt: string;
  currency: string;
  total: number;
  // ---- Extended checkout data (WO-068) ----
  /** Stable draft identifier — used in analytics and error recovery. */
  draftId: string;
  /** Steps that have been successfully completed. */
  completedSteps: CheckoutStep[];
  /** Collected step form data. */
  stepData: CheckoutStepData;
  /** Revalidated quote total (set after ReviewStep revalidation). */
  revalidatedTotal?: number;
}

const STORAGE_KEY = "booking_draft";

export function saveDraft(draft: BookingDraft): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // sessionStorage unavailable (private mode) — proceed without draft
  }
}

export function loadDraft(): BookingDraft | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BookingDraft;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isDraftExpired(draft: BookingDraft): boolean {
  return new Date(draft.quoteExpiresAt).getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Step data helpers (WO-068)
// ---------------------------------------------------------------------------

/** Merge step data into the draft and persist. */
export function updateDraftStep(
  draft: BookingDraft,
  stepData: Partial<CheckoutStepData>,
  completedStep?: CheckoutStep,
): BookingDraft {
  const updated: BookingDraft = {
    ...draft,
    stepData: { ...draft.stepData, ...stepData },
    completedSteps: completedStep
      ? Array.from(new Set([...draft.completedSteps, completedStep]))
      : draft.completedSteps,
  };
  saveDraft(updated);
  return updated;
}

/** Return the last completed step, or null if none. */
export function lastCompletedStep(draft: BookingDraft): CheckoutStep | null {
  const steps: CheckoutStep[] = ["traveler", "extras", "review", "payment"];
  for (let i = steps.length - 1; i >= 0; i--) {
    if (draft.completedSteps.includes(steps[i])) return steps[i];
  }
  return null;
}
