/**
 * @travel/contracts — Itinerary domain schemas (WO-053).
 *
 * All types are inferred from Zod schemas; hand-written duplicates are
 * forbidden.  Every breaking change must version the contract baseline.
 */
import { z } from "zod";
import { identifier, isoDateString, currencyCode } from "../common/primitives.js";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/** One booking's summary as it appears inside an itinerary response. */
export const ItineraryBookingSummarySchema = z
  .object({
    id: identifier,
    bookingType: z.string(),
    status: z.string(),
    totalPrice: z.string(),
    currency: currencyCode,
  })
  .strict();

export type ItineraryBookingSummary = z.infer<typeof ItineraryBookingSummarySchema>;

/** Summed total for a single currency inside an itinerary. */
export const CurrencyTotalSchema = z
  .object({
    currency: currencyCode,
    amount: z.string(),
  })
  .strict();

export type CurrencyTotal = z.infer<typeof CurrencyTotalSchema>;

// ---------------------------------------------------------------------------
// CreateItineraryRequest
// ---------------------------------------------------------------------------

export const CreateItineraryRequestSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(120, "name must not exceed 120 characters"),
    description: z.string().optional(),
    startDate: isoDateString,
    endDate: isoDateString,
    bookingIds: z
      .array(identifier)
      .min(2, "bookingIds must contain at least two entries"),
  })
  .strict()
  .refine((d) => d.endDate.getTime() > d.startDate.getTime(), {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });

export type CreateItineraryRequest = z.infer<typeof CreateItineraryRequestSchema>;

// ---------------------------------------------------------------------------
// UpdateItineraryRequest (PATCH — all fields optional)
// ---------------------------------------------------------------------------

/**
 * Partial update request.  Either addBookingIds or removeBookingIds (or both)
 * may be provided to atomically attach/detach bookings in one request.
 */
export const UpdateItineraryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().optional(),
    startDate: isoDateString.optional(),
    endDate: isoDateString.optional(),
    addBookingIds: z.array(identifier).optional(),
    removeBookingIds: z.array(identifier).optional(),
  })
  .strict()
  .refine(
    (d) => {
      if (d.startDate && d.endDate) return d.endDate.getTime() > d.startDate.getTime();
      return true;
    },
    {
      message: "endDate must be after startDate",
      path: ["endDate"],
    },
  );

export type UpdateItineraryRequest = z.infer<typeof UpdateItineraryRequestSchema>;

// ---------------------------------------------------------------------------
// ItineraryResponse
// ---------------------------------------------------------------------------

export const ItineraryResponseSchema = z
  .object({
    id: identifier,
    name: z.string(),
    description: z.string().nullish(),
    startDate: z.string(),
    endDate: z.string(),
    bookings: z.array(ItineraryBookingSummarySchema),
    totals: z.array(CurrencyTotalSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type ItineraryResponse = z.infer<typeof ItineraryResponseSchema>;

/** Paginated list wrapper. */
export const ItineraryListResponseSchema = z
  .object({
    items: z.array(ItineraryResponseSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type ItineraryListResponse = z.infer<typeof ItineraryListResponseSchema>;
