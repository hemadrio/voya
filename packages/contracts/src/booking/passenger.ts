import { z } from "zod";
import { isoDateString } from "../common/primitives.js";

export const NAME_REQUIRED_MESSAGE = "Name must not be empty";
export const PASSENGER_EMAIL_INVALID_MESSAGE = "Email must be a valid email address";

export const PassengerInfoSchema = z
  .object({
    firstName: z.string().trim().min(1, { message: NAME_REQUIRED_MESSAGE }),
    lastName: z.string().trim().min(1, { message: NAME_REQUIRED_MESSAGE }),
    dateOfBirth: isoDateString,
    email: z.string().trim().email({ message: PASSENGER_EMAIL_INVALID_MESSAGE }).optional(),
    passportNumber: z.string().trim().min(1).optional(),
  })
  .strict();

export type PassengerInfo = z.infer<typeof PassengerInfoSchema>;
