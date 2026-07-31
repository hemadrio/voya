import { z } from "zod";
import { currencyCode, isoDateString, positiveMoney } from "../common/primitives.js";
import { FreshnessLabelSchema, ProvenanceSchema } from "../common/enums.js";

export const ILLUSTRATIVE_NOT_BOOKABLE_MESSAGE = "An ILLUSTRATIVE offer must never be bookable";

const OfferBaseSchema = z
  .object({
    id: z.string().trim().min(1),
    provenance: ProvenanceSchema,
    bookable: z.boolean(),
    title: z.string().trim().min(1),
    price: positiveMoney,
    currency: currencyCode,
    rating: z.number().min(0).max(5).optional(),
    reviews: z.number().int().min(0).optional(),
    details: z.record(z.string(), z.unknown()),
    expiresAt: isoDateString,
    freshness: FreshnessLabelSchema,
  })
  .strict();

/**
 * The unified offer shape (target architecture). Replaces the legacy
 * provider enum (`AMADEUS`/`HOTELS_API`/`PRICELINE`/`AI_FALLBACK`) with
 * `provenance` (`AMADEUS` | `RAPIDAPI` | `ILLUSTRATIVE`) plus an explicit
 * `bookable` boolean, `expiresAt`, and a `freshness` staleness label.
 *
 * The booking service structurally rejects any offer whose provenance is
 * not a real supplier: this schema makes `provenance === "ILLUSTRATIVE" &&
 * bookable === true` an impossible combination, so "non-bookable" is a
 * structural property rather than a UI convention.
 */
export const OfferSchema = OfferBaseSchema.superRefine((data, ctx) => {
  if (data.provenance === "ILLUSTRATIVE" && data.bookable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bookable"],
      message: ILLUSTRATIVE_NOT_BOOKABLE_MESSAGE,
    });
  }
});

export type Offer = z.infer<typeof OfferSchema>;
