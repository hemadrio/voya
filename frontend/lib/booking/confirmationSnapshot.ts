/**
 * Confirmation snapshot — a minimal record saved to sessionStorage just before
 * the draft and idempotency key are cleared, so the confirmation page can display
 * booking reference, dates, total, and cancellation deadline without requiring
 * an additional API call (WO-068, AC10).
 *
 * The snapshot is consumed once by the confirmation page and then cleared.
 */

const STORAGE_KEY = "booking_confirmation_snapshot";

export interface ConfirmationSnapshot {
  bookingId: string;
  reference: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  infants: number;
  currency: string;
  total: number;
  cancellationDeadline: string;
}

export function saveConfirmationSnapshot(snapshot: ConfirmationSnapshot): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // sessionStorage unavailable — gracefully degrade
  }
}

export function loadConfirmationSnapshot(
  bookingId: string,
): ConfirmationSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConfirmationSnapshot;
    // Only return if it matches the current booking
    return parsed.bookingId === bookingId ? parsed : null;
  } catch {
    return null;
  }
}

export function clearConfirmationSnapshot(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
