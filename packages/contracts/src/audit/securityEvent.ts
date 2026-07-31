import { z } from "zod";
import { RoleSchema } from "../common/enums.js";

export const SecurityDecisionSchema = z.enum(["ALLOW", "DENY"]);
export type SecurityDecision = z.infer<typeof SecurityDecisionSchema>;

/**
 * Schema for immutable security events emitted on every 403 and
 * actor-context verification failure.  Written through an append-only
 * store (INSERT-only application grants).
 */
export const SecurityEventSchema = z
  .object({
    actorId: z.string().min(1),
    actorRole: RoleSchema,
    resourceType: z.string().min(1),
    resourceId: z.string().optional(),
    operation: z.string().min(1),
    decision: SecurityDecisionSchema,
    reason: z.string().optional(),
    occurredAt: z.string().datetime(),
  })
  .strict();

export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

/** Input type for writing security events (occurredAt is auto-set by the writer). */
export type SecurityEventInput = Omit<SecurityEvent, "occurredAt">;
