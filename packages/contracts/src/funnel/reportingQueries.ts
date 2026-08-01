/**
 * Reporting query result types for the six committed funnel metrics (WO-106 AC7).
 *
 * These are pure TypeScript types — no Zod, no DB dependencies.
 * The FunnelRepository that implements these queries lives in booking-service.
 */

// ---------------------------------------------------------------------------
// Common window type for all reporting queries
// ---------------------------------------------------------------------------

export interface MeasurementWindow {
  /** Inclusive start of the measurement period (UTC). */
  fromDate: Date;
  /** Exclusive end of the measurement period (UTC). */
  toDate: Date;
}

/**
 * When true, the requested measurement window extends past the funnel retention
 * boundary (purge_after for events in the window).  Ratios derived from a
 * truncated cohort are understated and must not be used as authoritative metrics.
 */
export interface ReportingResult {
  window: MeasurementWindow;
  incompleteWindow: boolean;
}

// ---------------------------------------------------------------------------
// 1. Search-to-booking conversion
// ---------------------------------------------------------------------------

export interface SearchToBookingResult extends ReportingResult {
  searchCount: number;
  bookingCount: number;
  /** bookingCount / searchCount, null if searchCount === 0. */
  conversionRate: number | null;
  /** Target: 4.0% (0.04). */
  targetRate: number;
}

// ---------------------------------------------------------------------------
// 2. Assistant-attributed conversion
// ---------------------------------------------------------------------------

export interface AssistantConversionResult extends ReportingResult {
  assistantBookingCount: number;
  totalBookingCount: number;
  /** assistantBookingCount / totalBookingCount. Target: 20% (0.20). */
  attributionRate: number | null;
  targetRate: number;
}

// ---------------------------------------------------------------------------
// 3. Multi-category attachment
// ---------------------------------------------------------------------------

export interface MultiCategoryAttachmentResult extends ReportingResult {
  /** Itineraries with 2+ distinct categories. */
  multiCategoryItineraryCount: number;
  totalItineraryCount: number;
  /** multiCategoryItineraryCount / totalItineraryCount. Target: 30% (0.30). */
  attachmentRate: number | null;
  targetRate: number;
}

// ---------------------------------------------------------------------------
// 4. Guest-to-registration conversion
// ---------------------------------------------------------------------------

export interface GuestToRegistrationResult extends ReportingResult {
  guestSessionCount: number;
  registrationCount: number;
  /** registrationCount / guestSessionCount. Target: 25% (0.25). */
  conversionRate: number | null;
  targetRate: number;
}

// ---------------------------------------------------------------------------
// 5. Conversation completion to shortlist
// ---------------------------------------------------------------------------

export interface ConversationCompletionResult extends ReportingResult {
  conversationsStarted: number;
  shortlistsPresentedCount: number;
  /** shortlistsPresentedCount / conversationsStarted. Target: 70% (0.70). */
  completionRate: number | null;
  targetRate: number;
}

// ---------------------------------------------------------------------------
// 6. Repeat booking rate (180-day cohort)
// ---------------------------------------------------------------------------

export interface RepeatBookingResult extends ReportingResult {
  /** Unique pseudonymous actors with ≥1 confirmed booking in the window. */
  uniqueBookers: number;
  /** Actors from uniqueBookers who made a second confirmed booking. */
  repeatBookers: number;
  /** repeatBookers / uniqueBookers. Target: 15% (0.15) within 180 days. */
  repeatRate: number | null;
  targetRate: number;
  windowDays: number;
}
