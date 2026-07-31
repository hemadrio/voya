/**
 * amadeusOfferMapper — translates Amadeus v2 flight-offer payloads into the
 * port-neutral Offer shape from @travel/contracts.
 *
 * All Amadeus-specific quirks (segment arrays, ISO-8601 duration strings,
 * price breakdown, cabin codes, last-ticketing-date semantics) are absorbed
 * here and nowhere else.  Downstream code never sees raw Amadeus payloads.
 *
 * Deterministic offer ID: sha256("AMADEUS:" + amadeusOfferId + ":" + searchFingerprint).
 * The same offer returned for the same search always produces the same platform ID,
 * enabling GET /v1/offers/{id} resolution without a lookup table.
 */

import { createHash } from 'node:crypto';
import type { Offer } from '@travel/contracts';
import type { FlightSearchCriteria } from '@travel/supplier-port';

// ---------------------------------------------------------------------------
// Amadeus response shape (local types — never exported)
// ---------------------------------------------------------------------------

interface AmadeusSegment {
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  carrierCode: string;
  number?: string;
  numberOfStops?: number;
  duration?: string;
}

interface AmadeusItinerary {
  duration: string;
  segments: AmadeusSegment[];
}

interface AmadeusPrice {
  currency: string;
  total: string;
  grandTotal?: string;
}

interface AmadeusFareDetail {
  cabin?: string;
}

interface AmadeusTravelerPricing {
  fareDetailsBySegment?: AmadeusFareDetail[];
}

interface AmadeusOffer {
  id: string;
  itineraries: AmadeusItinerary[];
  price: AmadeusPrice;
  validatingAirlineCodes?: string[];
  travelerPricings?: AmadeusTravelerPricing[];
  lastTicketingDate?: string;
  lastTicketingDateTime?: string;
}

export interface AmadeusSearchResponse {
  data?: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an ISO-8601 duration string (e.g. "PT7H30M") into total minutes. */
function parseDurationMinutes(iso: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?/i.exec(iso);
  if (!match) return 0;
  const hours = parseInt(match[1] ?? '0', 10);
  const mins = parseInt(match[2] ?? '0', 10);
  return hours * 60 + mins;
}

/** Map an Amadeus cabin code to the platform's SeatClass values. */
function mapCabin(cabin: string | undefined): string {
  const map: Record<string, string> = {
    ECONOMY: 'ECONOMY',
    PREMIUM_ECONOMY: 'ECONOMY',
    BUSINESS: 'BUSINESS',
    FIRST: 'FIRST',
  };
  return map[cabin?.toUpperCase() ?? ''] ?? 'ECONOMY';
}

/**
 * Build a deterministic platform offer ID.
 * Combines supplier name, supplier offer ID, and a search fingerprint so the
 * same Amadeus offer for the same search consistently maps to one platform ID.
 */
function makeOfferId(amadeusOfferId: string, fingerprint: string): string {
  return createHash('sha256')
    .update(`AMADEUS:${amadeusOfferId}:${fingerprint}`)
    .digest('hex');
}

/**
 * Derive a compact fingerprint from the search criteria.
 * Used only as part of the deterministic offer ID — not a security primitive.
 */
export function buildSearchFingerprint(criteria: FlightSearchCriteria): string {
  const key = [
    criteria.departureAirport,
    criteria.arrivalAirport,
    criteria.departureDate instanceof Date
      ? criteria.departureDate.toISOString().slice(0, 10)
      : String(criteria.departureDate),
    String(criteria.passengers),
    criteria.seatClass,
    criteria.currency,
  ].join(':');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Parse the offer expiry from Amadeus fields.
 * Prefers lastTicketingDateTime, then lastTicketingDate (assumed 23:59:59 UTC).
 * Returns undefined when neither field is present.
 */
function parseExpiresAt(
  lastTicketingDate?: string,
  lastTicketingDateTime?: string,
): Date | undefined {
  const raw = lastTicketingDateTime ?? lastTicketingDate;
  if (!raw) return undefined;
  // lastTicketingDate is YYYY-MM-DD; treat as end-of-day UTC
  const iso = raw.includes('T') ? raw : `${raw}T23:59:59Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Build a human-readable offer title from itinerary segments. */
function buildTitle(offer: AmadeusOffer): string {
  const first = offer.itineraries[0];
  if (!first || first.segments.length === 0) return 'Flight offer';
  const dep = first.segments[0]!.departure.iataCode;
  const arr = first.segments[first.segments.length - 1]!.arrival.iataCode;
  const carriers = offer.validatingAirlineCodes ?? [first.segments[0]!.carrierCode];
  const stops = first.segments.length - 1;
  const durationMin = parseDurationMinutes(first.duration);
  const hrs = Math.floor(durationMin / 60);
  const mins = durationMin % 60;
  const durationStr = hrs > 0 ? `${hrs}h${mins > 0 ? `${mins}m` : ''}` : `${mins}m`;
  const stopStr = stops === 0 ? 'Nonstop' : `${stops} stop${stops > 1 ? 's' : ''}`;
  return `${carriers.join('/')} ${dep}→${arr} · ${stopStr} · ${durationStr}`;
}

// ---------------------------------------------------------------------------
// Mapper (exported)
// ---------------------------------------------------------------------------

/**
 * Map an Amadeus v2 flight-offers search response to platform Offer objects.
 *
 * @param response - Parsed Amadeus response body.
 * @param criteria - The original search criteria (for fingerprinting).
 * @param defaultValidityMinutes - Validity window when Amadeus omits expiry.
 * @param now - Current timestamp (injectable for deterministic tests).
 */
export function mapAmadeusOffers(
  response: AmadeusSearchResponse,
  criteria: FlightSearchCriteria,
  defaultValidityMinutes: number,
  now: Date,
): ReadonlyArray<Offer> {
  const offers = (response.data ?? []) as AmadeusOffer[];
  const fingerprint = buildSearchFingerprint(criteria);
  const defaultExpiry = new Date(now.getTime() + defaultValidityMinutes * 60_000);

  return offers.map((raw): Offer => {
    const itinerary = raw.itineraries[0] ?? { duration: 'PT0M', segments: [] };
    const firstFare = raw.travelerPricings?.[0]?.fareDetailsBySegment?.[0];
    const cabinClass = mapCabin(firstFare?.cabin);
    const stops = itinerary.segments.length > 0 ? itinerary.segments.length - 1 : 0;
    const durationMinutes = parseDurationMinutes(itinerary.duration);
    const carrierCodes = raw.validatingAirlineCodes ?? itinerary.segments.map((s) => s.carrierCode);
    const expiresAt = parseExpiresAt(raw.lastTicketingDate, raw.lastTicketingDateTime) ?? defaultExpiry;
    const price = parseFloat(raw.price.total);

    return {
      id: makeOfferId(raw.id, fingerprint),
      provenance: 'AMADEUS',
      bookable: true,
      title: buildTitle(raw),
      price,
      currency: raw.price.currency,
      details: {
        supplier: 'AMADEUS',
        supplierOfferId: raw.id,
        cabinClass,
        stops,
        durationMinutes,
        carrierCodes,
        departure: {
          airport: itinerary.segments[0]?.departure.iataCode ?? '',
          at: itinerary.segments[0]?.departure.at ?? '',
        },
        arrival: {
          airport: itinerary.segments[itinerary.segments.length - 1]?.arrival.iataCode ?? '',
          at: itinerary.segments[itinerary.segments.length - 1]?.arrival.at ?? '',
        },
      },
      expiresAt,
      freshness: 'FRESH',
    };
  });
}
