import { z } from "zod";

// ---------------------------------------------------------------------------
// get_offer — lookup a specific offer by ID
// ---------------------------------------------------------------------------

export const GetOfferInputSchema = z
  .object({
    offerId: z.string().trim().min(1, { message: "offerId must be a non-empty string" }),
  })
  .strict();

export type GetOfferInput = z.infer<typeof GetOfferInputSchema>;

// ---------------------------------------------------------------------------
// get_user_preferences — fetch the authenticated user's travel preferences
//
// No model-supplied fields — identity comes from the server-side ToolContext
// (JWT sub claim).  An empty object is a valid call from a guest context.
// ---------------------------------------------------------------------------

export const GetUserPreferencesInputSchema = z.object({}).strict();

export type GetUserPreferencesInput = z.infer<typeof GetUserPreferencesInputSchema>;

// ---------------------------------------------------------------------------
// Output schemas (permissive — downstream schemas are owned by respective
// services; we declare the minimum shape for AI-domain contract testing).
// ---------------------------------------------------------------------------

export const OfferLookupResultSchema = z
  .object({
    id: z.string(),
    provenance: z.string(),
    bookable: z.boolean(),
  })
  .passthrough();

export type OfferLookupResult = z.infer<typeof OfferLookupResultSchema>;

export const UserPreferencesResultSchema = z
  .object({
    seatClass: z.string().optional(),
    dietaryRestrictions: z.array(z.string()).optional(),
    roomPreferences: z.array(z.string()).optional(),
  })
  .passthrough();

export type UserPreferencesResult = z.infer<typeof UserPreferencesResultSchema>;
