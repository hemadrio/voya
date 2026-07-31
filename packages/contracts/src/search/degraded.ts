import { z } from "zod";

/**
 * Response-level degraded indicator included in search responses that contain
 * illustrative offers.
 *
 * Clients MUST render this as a visible non-bookable degraded state; it must
 * never be treated as ordinary inventory. AC6 of WO-030 requires this block
 * at the response level — not only per-offer via provenance/bookable — so that
 * clients that happen to ignore per-offer flags cannot silently render
 * illustrative results as real inventory.
 */
export const DegradedResultBlockSchema = z
  .object({
    illustrative: z.literal(true),
    unavailableSuppliers: z.array(z.string().trim().min(1)),
    reason: z.string().optional(),
  })
  .strict();

export type DegradedResultBlock = z.infer<typeof DegradedResultBlockSchema>;
