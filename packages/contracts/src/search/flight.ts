import { z } from "zod";
import { currencyCode, iataCode, isoDateString, isStrictlyFuture, isOnOrAfter } from "../common/primitives.js";
import { SeatClassSchema } from "../common/enums.js";

export const FUTURE_DEPARTURE_DATE_MESSAGE = "Departure date must be in the future";
export const RETURN_DATE_NOT_BEFORE_DEPARTURE_MESSAGE = "Return date must be on or after the departure date";
export const PASSENGER_COUNT_MESSAGE = "Passengers must be a whole number between 1 and 9";

const FlightSearchRequestBaseSchema = z
  .object({
    departureAirport: iataCode,
    arrivalAirport: iataCode,
    departureDate: isoDateString,
    returnDate: isoDateString.optional(),
    passengers: z
      .number()
      .int({ message: PASSENGER_COUNT_MESSAGE })
      .min(1, { message: PASSENGER_COUNT_MESSAGE })
      .max(9, { message: PASSENGER_COUNT_MESSAGE }),
    seatClass: SeatClassSchema,
    currency: currencyCode,
  })
  .strict();

/**
 * Flight search request (US-001 / BR-11).
 *
 * - `departureAirport` / `arrivalAirport`: 3-letter IATA codes.
 * - `departureDate`: must be strictly in the future (a value exactly equal
 *   to "now" is rejected — see `isStrictlyFuture`).
 * - `returnDate`: optional; when present, must be on or after
 *   `departureDate` (a one-way same-day-return trip is allowed).
 * - `passengers`: integer 1–9 inclusive.
 */
export const FlightSearchRequestSchema = FlightSearchRequestBaseSchema.superRefine((data, ctx) => {
  if (!isStrictlyFuture(data.departureDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["departureDate"],
      message: FUTURE_DEPARTURE_DATE_MESSAGE,
    });
  }

  if (data.returnDate !== undefined && !isOnOrAfter(data.returnDate, data.departureDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["returnDate"],
      message: RETURN_DATE_NOT_BEFORE_DEPARTURE_MESSAGE,
    });
  }
});

export type FlightSearchRequest = z.infer<typeof FlightSearchRequestSchema>;
