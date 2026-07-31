import { z } from "zod";
import { identifier, currencyCode } from "../common/primitives.js";
import { AnyProvenanceSchema } from "./provenance.js";

/**
 * A single leg within an offer (flight segment, hotel stay, or car rental).
 * Fields are intentionally permissive — leg descriptors differ between
 * suppliers and the snapshot must capture whatever the supplier sent.
 */
export const OfferLegSchema = z
  .object({
    offerId: z.string().min(1),
    supplier: z.string().min(1),
    provenance: z.string().min(1),
    origin: z.string().optional(),
    destination: z.string().optional(),
    departureAt: z.string().optional(),
    arrivalAt: z.string().optional(),
    checkInDate: z.string().optional(),
    checkOutDate: z.string().optional(),
    pickUpDate: z.string().optional(),
    dropOffDate: z.string().optional(),
  })
  .passthrough();

export type OfferLeg = z.infer<typeof OfferLegSchema>;

/**
 * Immutable offer snapshot frozen at booking-creation time (WO-039).
 *
 * This is the court-admissible record of exactly what was offered and at what
 * price when the traveler clicked "Book". The service-side price always wins —
 * the client price is ignored in favour of the resolved offer price.
 *
 * Money is stored as a decimal string (e.g. "412.50") to avoid IEEE-754
 * float artefacts; no floating-point arithmetic anywhere in this path.
 */
export const OfferSnapshotSchema = z
  .object({
    offerId: identifier,
    provenance: AnyProvenanceSchema,
    supplier: z.string().min(1),
    /** Decimal string representation (e.g. "412.50") — never a JS number. */
    totalPrice: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, "Price must be a decimal string with at most 2 decimal places"),
    currency: currencyCode,
    bookable: z.boolean(),
    /** ISO-8601 timestamp at which the supplier offer expires. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    legs: z.array(OfferLegSchema).optional(),
  })
  .strict();

export type OfferSnapshot = z.infer<typeof OfferSnapshotSchema>;
