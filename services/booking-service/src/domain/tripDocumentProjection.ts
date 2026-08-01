/**
 * tripDocumentProjection — allow-list projection from itinerary read model to
 * TripDocumentViewModel (WO-054, AC4/5).
 *
 * Security invariant: this function is the ONLY path from raw booking data to
 * the PDF renderer.  It never spreads the booking record or the passengers JSON
 * blob.  Every field is enumerated explicitly, so dateOfBirth, passportNumber,
 * and full payment identifiers cannot appear in the output at compile time.
 *
 * Pure function — no I/O, no side effects — so it is trivially unit-testable
 * with synthetic inputs including poisoned PII fields.
 */

import type {
  TripDocumentViewModel,
  BookingDocumentViewModel,
  TravellerViewModel,
  DocumentCurrencyTotal,
} from "@travel/contracts/documents";

// ---------------------------------------------------------------------------
// Input types — represent what the service fetches from the DB.
// These types are defined here (not in the DB layer) so the projection owns
// its own input contract.
// ---------------------------------------------------------------------------

/**
 * Name-only traveller record.
 *
 * The query layer must project ONLY these two fields from the passengers JSON
 * column.  This type has no dateOfBirth, passportNumber, or documentType —
 * structural exclusion, not a runtime filter.
 */
export interface TravellerNameInput {
  givenName: string;
  familyName: string;
  // NOTE: No dateOfBirth. No passportNumber. No documentType.
  // If the query layer accidentally passes extra fields they are dropped by
  // the explicit pick in the projection.
}

/** Per-booking input for the document projection. */
export interface BookingDocumentInput {
  id: string;
  bookingType: string;
  status: string;
  /** Supplier name (e.g. "AMADEUS", "RAPIDAPI_HOTEL"). May be absent for older bookings. */
  supplier?: string | null;
  /** Traveller-facing booking confirmation code. Never a PaymentIntent id or full PAN. */
  confirmationReference?: string | null;
  travelStartDate?: string | null;
  travelEndDate?: string | null;
  origin?: string | null;
  destination?: string | null;
  totalPrice: string;
  currency: string;
  /** Name-only traveller records.  Must not include PII beyond given/family name. */
  travellers: TravellerNameInput[];
}

/** Full itinerary input for the document projection. */
export interface ItineraryDocumentInput {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  bookings: BookingDocumentInput[];
  totals: CurrencyTotalInput[];
}

export interface CurrencyTotalInput {
  currency: string;
  amount: string;
}

// ---------------------------------------------------------------------------
// Projection — explicit field-by-field mapping.
// ---------------------------------------------------------------------------

function projectTraveller(t: TravellerNameInput): TravellerViewModel {
  // Explicit field pick — only givenName and familyName are passed through.
  // If the input somehow contained dateOfBirth or passportNumber they are
  // silently dropped here and do not reach the view model or the renderer.
  return {
    givenName: t.givenName || "(name unavailable)",
    familyName: t.familyName || "",
  };
}

function projectBooking(b: BookingDocumentInput): BookingDocumentViewModel {
  const travellers = (b.travellers ?? []).map(projectTraveller);

  return {
    id: b.id,
    bookingType: b.bookingType,
    status: b.status,
    ...(b.supplier ? { supplier: b.supplier } : {}),
    ...(b.confirmationReference ? { confirmationReference: b.confirmationReference } : {}),
    ...(b.travelStartDate ? { travelStartDate: b.travelStartDate } : {}),
    ...(b.travelEndDate ? { travelEndDate: b.travelEndDate } : {}),
    ...(b.origin ? { origin: b.origin } : {}),
    ...(b.destination ? { destination: b.destination } : {}),
    price: b.totalPrice,
    currency: b.currency,
    travellers,
  };
}

function projectTotal(t: CurrencyTotalInput): DocumentCurrencyTotal {
  return { currency: t.currency, amount: t.amount };
}

/**
 * Project an itinerary read model into the TripDocumentViewModel.
 *
 * @param itinerary - Itinerary read model (from TripDocumentRepositoryPort)
 * @param documentId - Persisted document row id
 * @param generatedAt - Generation timestamp (ISO 8601)
 * @param locale - Locale for rendering (default "en")
 */
export function projectToTripDocument(
  itinerary: ItineraryDocumentInput,
  documentId: string,
  generatedAt: string,
  locale: string = "en",
): TripDocumentViewModel {
  return {
    documentId,
    itineraryId: itinerary.id,
    itineraryName: itinerary.name,
    startDate: itinerary.startDate,
    endDate: itinerary.endDate,
    generatedAt,
    locale,
    bookings: itinerary.bookings.map(projectBooking),
    totals: itinerary.totals.map(projectTotal),
  };
}
