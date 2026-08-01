import { z } from "zod";

/**
 * PATCH /v1/bookings/{id} request body — WO-044.
 *
 * Traveler-only modifications: optional contact fields and a human-readable
 * reason for the modification (written to the audit row).
 *
 * Identity document edits (dateOfBirth, passportNumber) are deliberately
 * excluded from this schema — they are only editable through the traveler
 * profile path where KMS re-encryption happens (WO-073).
 *
 * support_agent may not submit this endpoint; only `traveler` role is
 * permitted (enforced by requireRole middleware and BookingEntitlementService).
 */
export const PatchBookingRequestSchema = z
  .object({
    /** Updated contact phone. Omit to leave unchanged. */
    contactPhone: z.string().trim().min(1).max(64).optional(),
    /** Updated contact email. Omit to leave unchanged. */
    contactEmail: z.string().trim().email().optional(),
    /** Human-readable reason for the modification (written to audit row). */
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (d) => d.contactPhone !== undefined || d.contactEmail !== undefined,
    { message: "At least one field (contactPhone, contactEmail) must be provided" },
  );

export type PatchBookingRequest = z.infer<typeof PatchBookingRequestSchema>;
