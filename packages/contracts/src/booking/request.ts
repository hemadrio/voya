import { z } from "zod";
import { currencyCode, identifier, positiveMoney } from "../common/primitives.js";
import { BookingTypeSchema } from "../common/enums.js";
import { PassengerInfoSchema } from "./passenger.js";

export const PASSENGERS_REQUIRED_MESSAGE = "At least one passenger is required";
export const CONTACT_EMAIL_INVALID_MESSAGE = "Contact email must be a valid email address";

/**
 * CreateBookingRequest carries an immutable snapshot of the selected offer
 * (`offerId` + `offerPrice`/`currency` at selection time) plus the
 * idempotency key the saga orchestrator uses to guarantee a booking is only
 * ever created once per client attempt.
 */
export const CreateBookingRequestSchema = z
  .object({
    bookingType: BookingTypeSchema,
    offerId: identifier,
    offerPrice: positiveMoney,
    currency: currencyCode,
    passengers: z.array(PassengerInfoSchema).min(1, { message: PASSENGERS_REQUIRED_MESSAGE }),
    contactEmail: z.string().trim().email({ message: CONTACT_EMAIL_INVALID_MESSAGE }),
    contactPhone: z.string().trim().min(1).optional(),
    idempotencyKey: identifier,
  })
  .strict();

export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;
