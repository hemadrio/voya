/**
 * Shared error-envelope assertion helper.
 *
 * Validates that a JSON response:
 *  1. Parses successfully against ErrorEnvelopeSchema (strict — no extra keys)
 *  2. Contains no stack trace or internal detail (policy A10)
 *  3. Has a non-empty reference value
 *  4. Optionally: reference matches a captured trace identifier
 *
 * All contract tests import this helper rather than duplicating the assertion
 * logic. A change to the envelope schema requires only this file to update.
 */
import { ErrorEnvelopeSchema } from "@travel/contracts/errors";

// Keys that must NEVER appear anywhere in an error response body
const INTERNAL_KEYS = new Set([
  "stack",
  "cause",
  "trace",
  "internal",
  "sql",
  "query",
  "prismaCode",
  "clientVersion",
]);

export interface EnvelopeAssertionResult {
  passed: boolean;
  errors: string[];
  envelope: ReturnType<typeof ErrorEnvelopeSchema.safeParse> extends { data: infer T } ? T : never;
}

/**
 * Assert that `body` is a valid error envelope.
 * Returns the validated envelope on success; throws on failure.
 *
 * @param body - Raw response body (already JSON-parsed)
 * @param expectedTraceId - When provided, asserts reference === expectedTraceId
 */
export function assertErrorEnvelope(
  body: unknown,
  expectedTraceId?: string,
): asserts body is { error: { code: string; message: string; field?: string }; reference: string } {
  const errors: string[] = [];

  // 1. Strict parse against ErrorEnvelopeSchema
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    const messages = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    errors.push(`Schema validation failed: ${messages.join("; ")}`);
  }

  // 2. No internal keys anywhere in the serialised body
  const serialised = JSON.stringify(body);
  const bodyRecord = body != null && typeof body === "object" ? (body as Record<string, unknown>) : {};

  for (const key of INTERNAL_KEYS) {
    if (key in bodyRecord) {
      errors.push(`Internal key "${key}" must not appear in error response`);
    }
  }

  if (serialised.includes('"stack"')) {
    errors.push('Field "stack" must not appear in error response (A10)');
  }
  if (serialised.includes('"cause"')) {
    errors.push('Field "cause" must not appear in error response (A10)');
  }

  // 3. Non-empty reference
  if (parsed.success && !parsed.data.reference) {
    errors.push("reference must be a non-empty string");
  }

  // 4. Trace correlation (optional)
  if (expectedTraceId !== undefined && parsed.success) {
    if (parsed.data.reference !== expectedTraceId) {
      errors.push(
        `reference "${parsed.data.reference}" must equal trace ID "${expectedTraceId}"`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Error envelope assertion failed:\n  ${errors.join("\n  ")}\n\nBody: ${JSON.stringify(body, null, 2)}`,
    );
  }
}

/**
 * Non-throwing variant that returns a boolean. Suitable for property-based
 * assertions inside test loops.
 */
export function isValidErrorEnvelope(body: unknown): boolean {
  try {
    assertErrorEnvelope(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert the exact HTTP status code and that the response body is a valid
 * error envelope — combining status-semantics and envelope assertions.
 */
export function assertErrorResponse(
  actualStatus: number,
  expectedStatus: number,
  body: unknown,
  expectedTraceId?: string,
): void {
  if (actualStatus !== expectedStatus) {
    throw new Error(
      `Expected HTTP ${expectedStatus} but received HTTP ${actualStatus}.\nBody: ${JSON.stringify(body, null, 2)}`,
    );
  }
  assertErrorEnvelope(body, expectedTraceId);
}
