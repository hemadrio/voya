import { z } from "zod";
import { currencyCode, isoDateString, isStrictlyAfter } from "../common/primitives.js";
import { HotelStarRatingSchema } from "../common/enums.js";

export const LOCATION_REQUIRED_MESSAGE = "Location must not be empty";
export const CHECK_OUT_AFTER_CHECK_IN_MESSAGE = "Check-out date must be strictly after the check-in date";
export const GUEST_COUNT_MESSAGE = "Guests must be a whole number of at least 1";

const HotelSearchRequestBaseSchema = z
  .object({
    location: z.string().trim().min(1, { message: LOCATION_REQUIRED_MESSAGE }),
    checkInDate: isoDateString,
    checkOutDate: isoDateString,
    guests: z.number().int({ message: GUEST_COUNT_MESSAGE }).min(1, { message: GUEST_COUNT_MESSAGE }),
    starRating: HotelStarRatingSchema.optional(),
    currency: currencyCode,
  })
  .strict();

/**
 * Hotel search request. `checkOutDate` must be strictly after
 * `checkInDate` — a same-day stay (check-out === check-in) fails with the
 * error path naming `checkOutDate`, and no supplier call is implied.
 */
export const HotelSearchRequestSchema = HotelSearchRequestBaseSchema.superRefine((data, ctx) => {
  if (!isStrictlyAfter(data.checkOutDate, data.checkInDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["checkOutDate"],
      message: CHECK_OUT_AFTER_CHECK_IN_MESSAGE,
    });
  }
});

export type HotelSearchRequest = z.infer<typeof HotelSearchRequestSchema>;
