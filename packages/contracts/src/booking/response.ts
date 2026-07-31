import { z } from "zod";
import { currencyCode, identifier, isoDateString, positiveMoney } from "../common/primitives.js";
import { BookingStatusSchema, BookingTypeSchema } from "../common/enums.js";
import { PassengerInfoSchema } from "./passenger.js";

export const BookingResponseSchema = z
  .object({
    id: identifier,
    bookingType: BookingTypeSchema,
    status: BookingStatusSchema,
    offerId: identifier,
    totalPrice: positiveMoney,
    currency: currencyCode,
    passengers: z.array(PassengerInfoSchema).min(1),
    createdAt: isoDateString,
    updatedAt: isoDateString,
  })
  .strict();

export type BookingResponse = z.infer<typeof BookingResponseSchema>;

export const ItinerarySchema = z
  .object({
    id: identifier,
    userId: identifier,
    bookings: z.array(BookingResponseSchema),
    createdAt: isoDateString,
    updatedAt: isoDateString,
  })
  .strict();

export type Itinerary = z.infer<typeof ItinerarySchema>;
