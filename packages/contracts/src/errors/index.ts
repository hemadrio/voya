/**
 * @travel/contracts — errors module barrel.
 *
 * Re-exports the complete error contract surface:
 *   - `ErrorEnvelopeSchema` / `ErrorEnvelope` — the single platform-wide
 *     response shape every service returns on failure.
 *   - `ErrorCode` union and `ERROR_STATUS_MAP` / `httpStatusForCode` — the
 *     exhaustive code-to-HTTP-status binding.
 *   - Domain error factories (`validationFailed`, `forbidden`, …) — so
 *     services never construct HTTP responses inline.
 *   - `serialiseError` — converts any thrown value to `{ envelope, status }`
 *     so an Express error handler is three lines.
 *   - `RESTRICTED_FIELDS` — the redaction list mirroring the Pino logger
 *     paths.
 */
export { ErrorDetailSchema, ErrorEnvelopeSchema } from "./envelope.js";
export type { ErrorDetail, ErrorEnvelope } from "./envelope.js";

export { ErrorCode, ERROR_STATUS_MAP, ALLOWED_HTTP_STATUSES, httpStatusForCode } from "./codes.js";

export type { DomainError } from "./domain-errors.js";
export {
  validationFailed,
  unauthenticated,
  forbidden,
  notFound,
  conflict,
  lifecycleConflict,
  duplicateEmail,
  supplierRejected,
  rateLimited,
  supplierUnavailable,
  supplierTimeout,
} from "./domain-errors.js";

export { serialiseError, RESTRICTED_FIELDS } from "./serialise.js";
export type { SerialiseResult } from "./serialise.js";
