/**
 * Global Express Request augmentation — adds the `validated` property set
 * by the `validateRequest` middleware on parse success.
 *
 * Services include this file via their tsconfig `include` or `typeRoots`
 * settings once they have `@types/express` installed.
 *
 * The `validated` property is intentionally typed as `ValidatedData` (all
 * fields unknown) here — downstream handlers narrow the type by casting to
 * the inferred schema type, which is the safe, single-parse pattern.
 *
 * WHY `req.validated` instead of overwriting `req.body`:
 *   The Stripe webhook route must keep `req.body` as a raw Buffer for HMAC
 *   signature verification.  Overwriting `req.body` on that path would
 *   silently break signature verification.  Using a separate `validated`
 *   namespace avoids the conflict.
 */

import type { ValidatedData } from "../middleware/validateRequest.js";

declare global {
  namespace Express {
    interface Request {
      /** Parsed and coerced inputs set by `validateRequest` on success. */
      validated?: ValidatedData;
    }
  }
}

export {};
