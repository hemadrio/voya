/**
 * Booking display status and tab derivation (WO-069, AC2).
 *
 * Classifies a booking into one of four dashboard tabs:
 *  - upcoming    — confirmed, check-in is in the future
 *  - in_progress — confirmed, currently within the stay (check-in ≤ now < check-out)
 *  - past        — confirmed, check-out has passed
 *  - cancelled   — status is "cancelled" regardless of dates
 *
 * IMPORTANT: In-progress detection uses the listing timezone so that a traveler
 * in a different timezone sees the correct tab.  The listing timezone is provided
 * as an IANA timezone string (e.g. "Europe/Paris").
 */

import type { BookingStatus } from "../api/account.js";

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

export type TripTab = "upcoming" | "in_progress" | "past" | "cancelled";

// ---------------------------------------------------------------------------
// Cancellation-deadline helpers
// ---------------------------------------------------------------------------

/**
 * Returns the number of milliseconds until the cancellation deadline,
 * or null when no deadline is set.
 * Negative values mean the deadline has passed.
 */
export function msUntilDeadline(
  cancellationDeadline: string | null | undefined,
  nowMs?: number,
): number | null {
  if (!cancellationDeadline) return null;
  const now = nowMs ?? Date.now();
  return new Date(cancellationDeadline).getTime() - now;
}

/**
 * Returns true when the cancellation deadline is within the given threshold.
 * Returns false when no deadline is set.
 * Defaults to 48 hours (172_800_000 ms).
 */
export function isDeadlineImminent(
  cancellationDeadline: string | null | undefined,
  thresholdMs = 172_800_000,
  nowMs?: number,
): boolean {
  const ms = msUntilDeadline(cancellationDeadline, nowMs);
  if (ms === null) return false;
  return ms > 0 && ms <= thresholdMs;
}

/** Returns true when the cancellation deadline has passed. Returns false when no deadline. */
export function isDeadlinePassed(
  cancellationDeadline: string | null | undefined,
  nowMs?: number,
): boolean {
  const ms = msUntilDeadline(cancellationDeadline, nowMs);
  if (ms === null) return false;
  return ms <= 0;
}

// ---------------------------------------------------------------------------
// Timezone-aware date helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO date string (YYYY-MM-DD) to midnight in the given IANA timezone,
 * returning a UTC timestamp (ms).
 *
 * Uses Intl.DateTimeFormat to determine the UTC offset at that specific date in the
 * target timezone (correctly handles DST transitions).
 */
export function dateToTimezoneMs(isoDate: string, timezone: string): number {
  // Parse the parts
  const [year, month, day] = isoDate.split("-").map(Number);

  // Use Intl to find what UTC time corresponds to midnight local time
  // Strategy: format a known UTC time and binary-search isn't needed here.
  // Instead, create a date in local time using the timezone offset at that date.
  const candidate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  // Get the UTC offset in minutes for that candidate date in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(candidate);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);

  // The local time shown for candidate (UTC midnight)
  const localHour = get("hour") === 24 ? 0 : get("hour"); // handle 24:00 edge
  const localMinute = get("minute");
  const localSecond = get("second");

  // UTC offset in ms: if local shows H:M:S for UTC midnight, the offset is H*3600+M*60+S seconds ahead of UTC
  // But we want midnight LOCAL time → subtract that offset from candidate
  const offsetMs = (localHour * 3600 + localMinute * 60 + localSecond) * 1000;

  // Adjust: midnight local = candidate - offsetMs
  return candidate.getTime() - offsetMs;
}

// ---------------------------------------------------------------------------
// Tab derivation
// ---------------------------------------------------------------------------

export interface TabDerivationInput {
  status: BookingStatus;
  checkIn: string;   // ISO date YYYY-MM-DD
  checkOut: string;  // ISO date YYYY-MM-DD
  timezone: string;  // IANA timezone
}

/**
 * Derive which dashboard tab a booking belongs to.
 *
 * @param booking  Booking data
 * @param nowMs    Current time in ms (injectable for tests — defaults to Date.now())
 */
export function deriveTab(booking: TabDerivationInput, nowMs?: number): TripTab {
  const now = nowMs ?? Date.now();

  if (booking.status === "cancelled" || booking.status === "failed") {
    return "cancelled";
  }

  const checkInMs = dateToTimezoneMs(booking.checkIn, booking.timezone);
  const checkOutMs = dateToTimezoneMs(booking.checkOut, booking.timezone);

  if (now >= checkInMs && now < checkOutMs) return "in_progress";
  if (now >= checkOutMs) return "past";
  return "upcoming";
}

// ---------------------------------------------------------------------------
// Display status labels
// ---------------------------------------------------------------------------

export const DISPLAY_STATUS_LABELS: Record<BookingStatus, string> = {
  pending: "Awaiting confirmation",
  confirmed: "Confirmed",
  pending_modification: "Modification requested",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const TAB_LABELS: Record<TripTab, string> = {
  upcoming: "Upcoming",
  in_progress: "In progress",
  past: "Past",
  cancelled: "Cancelled",
};

// ---------------------------------------------------------------------------
// Countdown formatting
// ---------------------------------------------------------------------------

/**
 * Format remaining time as a human-readable string for aria-live regions.
 * Returns coarse labels (days / hours / minutes) to avoid excessive screen reader chatter.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "Deadline passed";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const days = Math.floor(hours / 24);

  if (days >= 1) return `${days} day${days !== 1 ? "s" : ""}`;
  if (hours >= 1) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  const minutes = totalMinutes % 60 || 1; // show at least 1 minute
  return `${minutes} minute${minutes !== 1 ? "s" : ""}`;
}
