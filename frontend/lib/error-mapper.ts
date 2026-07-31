/**
 * Maps a standard error envelope from @travel/contracts onto a React form's
 * field-error state, following the documented field-attachment rules:
 *
 *  1. If error.field is present and its top-level segment names a form field,
 *     the message is attached to that field.
 *  2. If the field path is absent or does not match any known form field, the
 *     message becomes a form-level banner.
 *  3. The reference value is always preserved so the traveler can quote it
 *     to support.
 *
 * This module is a pure function — no React, no DOM, safe in any environment.
 */

import type { ErrorEnvelope } from "@travel/contracts/errors";
import type { FormErrorState } from "../types/index.js";

/**
 * Convert an ErrorEnvelope into a FormErrorState suitable for React Hook
 * Form's `setError` or a custom form error store.
 *
 * @param envelope   The error envelope returned by apiGet / apiPost.
 * @param fieldNames The set of field names rendered in the current form.
 *                   Used to decide whether to attach the error to a field
 *                   or fall back to the form-level banner.
 */
export function mapEnvelopeToFormErrors(
  envelope: ErrorEnvelope,
  fieldNames: ReadonlyArray<string>
): FormErrorState {
  const { error, reference } = envelope;
  const fieldPath = error.field;

  if (fieldPath !== undefined && fieldPath.length > 0) {
    // The top-level segment is the form field name.
    // Nested paths (e.g. "passengers.0.passportNumber") attach to the
    // top-level field ("passengers") in the form.
    const topLevelSegment = fieldPath.split(".")[0] ?? "";

    if (fieldNames.includes(topLevelSegment)) {
      return {
        fieldErrors: { [topLevelSegment]: error.message },
        formError: undefined,
        reference,
      };
    }
  }

  // Field absent or unmatched — fall back to a form-level banner.
  return {
    fieldErrors: {},
    formError: error.message,
    reference,
  };
}

/**
 * Build a FormErrorState for a non-envelope error (network failure, etc.).
 * Always produces a form-level banner with a generated reference.
 */
export function formErrorFromMessage(
  message: string,
  reference: string
): FormErrorState {
  return {
    fieldErrors: {},
    formError: message,
    reference,
  };
}
