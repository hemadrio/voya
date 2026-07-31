import { z } from "zod";
import { currencyCode, identifier, isoDateString } from "../common/primitives.js";
import { RoleSchema, SeatClassSchema } from "../common/enums.js";

export const ProfileSchema = z
  .object({
    id: identifier,
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    role: RoleSchema,
    createdAt: isoDateString,
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

export const TravelPreferencesSchema = z
  .object({
    userId: identifier,
    preferredSeatClass: SeatClassSchema.optional(),
    preferredCurrency: currencyCode.optional(),
    preferredAirlines: z.array(z.string().trim().min(1)).optional(),
    dietaryRestrictions: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export type TravelPreferences = z.infer<typeof TravelPreferencesSchema>;
