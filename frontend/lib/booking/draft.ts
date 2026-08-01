/**
 * Booking draft — stores validated date/guest selection + quote reference
 * so the checkout page receives a pre-validated handoff without re-entry
 * (WO-067).
 *
 * Persisted to sessionStorage (client-only). No PII leaves the browser.
 */

"use client";

export interface BookingDraft {
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
