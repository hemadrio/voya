import { z } from "zod";
import { RoleSchema } from "../common/enums.js";

/**
 * Schema for the internal actor context forwarded by the gateway as the
 * x-internal-actor header (HMAC-signed, never client-supplied).
 *
 * Consumers MUST NOT construct this from client input — only the gateway
 * mints it after JWT verification and HMAC signing.
 */
export const InternalActorContextSchema = z
  .object({
    /** Subject — the authenticated user's UUID. */
    sub: z.string().min(1),
    /** Session ID — ties this context to a specific session family. */
    sid: z.string().min(1),
    /** Role claims — at least one role must be present. */
    roles: z.array(RoleSchema).min(1),
    /** JWT ID from the original access token — for denylist correlation. */
    jti: z.string().min(1),
    /** Issued-at timestamp (Unix epoch seconds). */
    issuedAt: z.number().int().positive(),
  })
  .strict();

export type InternalActorContext = z.infer<typeof InternalActorContextSchema>;
