import { z } from "zod";
import { currencyCode, isoDateString, isStrictlyAfter, isStrictlyFuture } from "../common/primitives.js";
import { CarClassSchema } from "../common/enums.js";

export const PICKUP_LOCATION_REQUIRED_MESSAGE = "Pickup location must not be empty";
export const DROPOFF_LOCATION_REQUIRED_MESSAGE = "Dropoff location must not be empty";
export const FUTURE_PICKUP_DATE_MESSAGE = "Pickup date must be in the future";
export const DROPOFF_AFTER_PICKUP_MESSAGE = "Dropoff date must be strictly after the pickup date";

const CarRentalSearchRequestBaseSchema = z
  .object({
    pickupLocation: z.string().trim().min(1, { message: PICKUP_LOCATION_REQUIRED_MESSAGE }),
    dropoffLocation: z.string().trim().min(1, { message: DROPOFF_LOCATION_REQUIRED_MESSAGE }),
    pickupDate: isoDateString,
    dropoffDate: isoDateString,
    carClass: CarClassSchema,
    currency: currencyCode,
  })
  .strict();

/**
 * Car rental search request. `pickupDate` must be strictly in the future
 * (same boundary rule as flight departure) and `dropoffDate` must be
 * strictly after `pickupDate`.
 */
export const CarRentalSearchRequestSchema = CarRentalSearchRequestBaseSchema.superRefine((data, ctx) => {
  if (!isStrictlyFuture(data.pickupDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pickupDate"],
      message: FUTURE_PICKUP_DATE_MESSAGE,
    });
  }

  if (!isStrictlyAfter(data.dropoffDate, data.pickupDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dropoffDate"],
      message: DROPOFF_AFTER_PICKUP_MESSAGE,
    });
  }
});

export type CarRentalSearchRequest = z.infer<typeof CarRentalSearchRequestSchema>;
