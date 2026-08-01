/**
 * Pure availability helpers — no React, no I/O.
 * All functions are deterministic and independently unit-testable (WO-067).
 */

import type { BlockedRange, AvailabilityResponse } from "../api/listings.js";

// ---------------------------------------------------------------------------
// Date helpers (all work with ISO "YYYY-MM-DD" strings)
// ---------------------------------------------------------------------------

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseDate(iso: string): Date {
  // Parse as UTC midnight to avoid timezone shifts
  return new Date(`${iso}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// computeNights — number of nights between check-in and check-out
// ---------------------------------------------------------------------------

export function computeNights(checkIn: string, checkOut: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (parseDate(checkOut).getTime() - parseDate(checkIn).getTime()) / msPerDay,
  );
}

// ---------------------------------------------------------------------------
// isRangeAvailable — true when the date range is fully open
// ---------------------------------------------------------------------------

export function isRangeAvailable(
  checkIn: string,
  checkOut: string,
  availability: AvailabilityResponse,
): boolean {
  const checkInMs = parseDate(checkIn).getTime();
  const checkOutMs = parseDate(checkOut).getTime();

  for (const blocked of availability.blockedRanges) {
    const blockedStart = parseDate(blocked.start).getTime();
    const blockedEnd = parseDate(blocked.end).getTime();
    // Overlap: [checkIn, checkOut) overlaps [blockedStart, blockedEnd)
    if (checkInMs < blockedEnd && checkOutMs > blockedStart) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// validateMinimumStay
// ---------------------------------------------------------------------------

export interface MinimumStayViolation {
  valid: false;
  reason: "minimum_stay";
  required: number;
  selected: number;
}

export interface CheckInDayViolation {
  valid: false;
  reason: "checkin_day";
  allowedDays: number[];
  selectedDay: number;
}

export interface MaximumStayViolation {
  valid: false;
  reason: "maximum_stay";
  maximum: number;
  selected: number;
}

export type StayValidation =
  | { valid: true }
  | MinimumStayViolation
  | CheckInDayViolation
  | MaximumStayViolation;

export function validateMinimumStay(
  checkIn: string,
  checkOut: string,
  availability: AvailabilityResponse,
  listingMinimumStay: number,
  listingMaximumStay?: number,
): StayValidation {
  const nights = computeNights(checkIn, checkOut);

  // Check minimum stay per date override first, then listing default
  const dateMin = availability.minimumStayByDate[checkIn] ?? listingMinimumStay;
  if (nights < dateMin) {
    return { valid: false, reason: "minimum_stay", required: dateMin, selected: nights };
  }

  if (listingMaximumStay !== undefined && nights > listingMaximumStay) {
    return {
      valid: false,
      reason: "maximum_stay",
      maximum: listingMaximumStay,
      selected: nights,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// validateCheckInDay — ensures check-in falls on an allowed day of week
// ---------------------------------------------------------------------------

export function validateCheckInDay(
  checkIn: string,
  availability: AvailabilityResponse,
): StayValidation {
  const allowed = availability.checkInAllowedDays;
  if (allowed.length === 0) return { valid: true };

  // getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const day = parseDate(checkIn).getUTCDay();
  if (!allowed.includes(day)) {
    return { valid: false, reason: "checkin_day", allowedDays: allowed, selectedDay: day };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// findNearestAvailableRange — suggests the closest available window
// ---------------------------------------------------------------------------

export function findNearestAvailableRange(
  preferredCheckIn: string,
  nights: number,
  availability: AvailabilityResponse,
  listingMinimumStay: number,
  maxSearchDays = 90,
): { checkIn: string; checkOut: string } | null {
  const msPerDay = 24 * 60 * 60 * 1000;
  const stayMs = nights * msPerDay;
  const preferredMs = parseDate(preferredCheckIn).getTime();

  for (let offset = 0; offset <= maxSearchDays; offset++) {
    const candidateIn = new Date(preferredMs + offset * msPerDay);
    const candidateOut = new Date(candidateIn.getTime() + stayMs);
    const checkIn = toDateOnly(candidateIn);
    const checkOut = toDateOnly(candidateOut);

    const actualNights = computeNights(checkIn, checkOut);
    if (actualNights < listingMinimumStay) continue;

    const dayCheck = validateCheckInDay(checkIn, availability);
    if (!dayCheck.valid) continue;

    if (isRangeAvailable(checkIn, checkOut, availability)) {
      return { checkIn, checkOut };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// getBlockedRangeReason — human-readable reason for a blocked range
// ---------------------------------------------------------------------------

export function getBlockedRangeReason(blocked: BlockedRange): string {
  switch (blocked.reason) {
    case "minimum_stay":
      return "Minimum stay requirement";
    case "booked":
      return "Already booked";
    case "blocked":
    default:
      return "Unavailable";
  }
}
