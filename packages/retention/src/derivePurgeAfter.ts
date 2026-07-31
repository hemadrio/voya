/**
 * derivePurgeAfter — one pure function per retention category.
 *
 * All functions return Date | null:
 *   - Date  → the computed purge_after timestamp
 *   - null  → purge_after is undecidable (e.g. trip not yet completed)
 *             the caller must write null and the backfill will quarantine it
 *
 * No database or AWS dependency. Durations come from RetentionConfig, which
 * is loaded from configuration at startup (not hard-coded literals).
 *
 * The same functions are used by the write path, backfill, and purge job
 * so derivation logic never diverges.
 */

import type { RetentionConfig } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

// ---------------------------------------------------------------------------
// Per-category derivation functions
// ---------------------------------------------------------------------------

/**
 * Account identity (users table).
 *
 * purge_after = erasure_requested_at + accountIdentityDays days
 * Returns null when no erasure request has been made (account is live).
 *
 * Edge case: if erasure is requested and then cancelled, the caller must
 * clear erasure_requested_at and re-derive (returns null again).
 */
export function deriveAccountIdentityPurgeAfter(
  erasureRequestedAt: Date | null | undefined,
  config: Pick<RetentionConfig, "accountIdentityDays">,
): Date | null {
  if (!erasureRequestedAt) return null;
  return addDays(erasureRequestedAt, config.accountIdentityDays);
}

/**
 * Authentication session (sessions table).
 *
 * purge_after = expires_at + sessionDays days
 * Always derivable because every session has an expiry.
 */
export function deriveSessionPurgeAfter(
  expiresAt: Date,
  config: Pick<RetentionConfig, "sessionDays">,
): Date {
  return addDays(expiresAt, config.sessionDays);
}

/**
 * One-time token (one_time_tokens table).
 * Same derivation as session: purge_after = expires_at + sessionDays.
 */
export function deriveOneTimeTokenPurgeAfter(
  expiresAt: Date,
  config: Pick<RetentionConfig, "sessionDays">,
): Date {
  return addDays(expiresAt, config.sessionDays);
}

/**
 * Booking transaction (bookings table).
 *
 * purge_after = created_at + transactionYears years
 *
 * A cancelled booking still follows this horizon for tax/dispute purposes.
 * purge_after must NOT shorten for cancelled bookings.
 */
export function deriveBookingPurgeAfter(
  createdAt: Date,
  config: Pick<RetentionConfig, "transactionYears">,
): Date {
  return addYears(createdAt, config.transactionYears);
}

/**
 * Traveler identity documents (booking_travelers table).
 *
 * purge_after = tripCompletedAt + identityDocumentDays days
 * Returns null when the trip has not yet completed (future or in-flight).
 *
 * Edge case: must never default to now + 90 days when tripCompletedAt is null.
 */
export function deriveTravelerIdentityPurgeAfter(
  tripCompletedAt: Date | null | undefined,
  config: Pick<RetentionConfig, "identityDocumentDays">,
): Date | null {
  if (!tripCompletedAt) return null;
  return addDays(tripCompletedAt, config.identityDocumentDays);
}

/**
 * Itinerary (itineraries table).
 *
 * purge_after = created_at + itineraryYears years
 */
export function deriveItineraryPurgeAfter(
  createdAt: Date,
  config: Pick<RetentionConfig, "itineraryYears">,
): Date {
  return addYears(createdAt, config.itineraryYears);
}

/**
 * Travel preferences (travel_preferences table).
 *
 * purge_after = updatedAt + preferenceDays days
 * Follows the account identity horizon.
 */
export function derivePreferencePurgeAfter(
  updatedAt: Date,
  config: Pick<RetentionConfig, "preferenceDays">,
): Date {
  return addDays(updatedAt, config.preferenceDays);
}

/**
 * Conversation history (Redis TTL; no Postgres row).
 *
 * Returns the target TTL expiry date so callers can set Redis EXPIREAT.
 * purge_after = lastMessageAt + conversationDays days
 */
export function deriveConversationPurgeAfter(
  lastMessageAt: Date,
  config: Pick<RetentionConfig, "conversationDays">,
): Date {
  return addDays(lastMessageAt, config.conversationDays);
}

/**
 * Audit record (booking_audit_log table).
 *
 * Audit records are excluded from the GDPR erasure sweep but are subject to
 * a long-horizon retention sweep. Returns the audit retention horizon.
 * purge_after = occurredAt + auditDays days
 */
export function deriveAuditPurgeAfter(
  occurredAt: Date,
  config: Pick<RetentionConfig, "auditDays">,
): Date {
  return addDays(occurredAt, config.auditDays);
}
