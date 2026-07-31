/**
 * Test fixtures for correlation ID validation and error mapping tests.
 *
 * AC10: committed fixtures for a valid inbound header, a malformed header,
 * and representative typed errors so all assertions run offline.
 */

// ---------------------------------------------------------------------------
// Correlation ID samples
// ---------------------------------------------------------------------------

/** Valid ULID — 26 Crockford Base32 characters. */
export const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Valid UUID v4. */
export const VALID_UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';

/** Too long (65 chars). */
export const OVERSIZED_CORRELATION_ID = 'A'.repeat(65);

/** Contains CRLF — header injection attempt. */
export const CRLF_INJECTION_ID = 'valid-start\r\nX-Injected: header';

/** Contains a newline character. */
export const NEWLINE_INJECTION_ID = 'valid-start\nX-Injected: evil';

/** Empty string. */
export const EMPTY_CORRELATION_ID = '';

/** Random alphanumeric — not ULID or UUID format. */
export const RANDOM_NON_FORMAT_ID = 'abc-def-ghi-12345';

/** UUID v5 (version 5, not version 4 — must be rejected). */
export const UUID_V5 = '886313e1-3b8a-5372-9b90-0c9aee199e5d';

// ---------------------------------------------------------------------------
// Outbound injection fixtures
// ---------------------------------------------------------------------------

/** A minimal set of HTTP headers representing an outbound supplier call. */
export const BASE_OUTBOUND_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'content-type': 'application/json',
};

/** Expected key names that injection should add. */
export const INJECTED_HEADER_KEYS = ['x-correlation-id'] as const;

// ---------------------------------------------------------------------------
// Error fixtures (aligned with @travel/contracts error envelope shape)
// ---------------------------------------------------------------------------

/** A representative validation error envelope as the client sees it. */
export const VALIDATION_ERROR_FIXTURE = {
  error: {
    code: 'VALIDATION_FAILED',
    message: 'departureAirport must be a valid 3-letter IATA code',
    field: 'departureAirport',
  },
  reference: VALID_ULID,
};

/** A supplier timeout error envelope. */
export const SUPPLIER_TIMEOUT_FIXTURE = {
  error: {
    code: 'SUPPLIER_TIMEOUT',
    message: 'Supplier request timed out',
  },
  reference: VALID_ULID,
};

/** A lifecycle conflict envelope. */
export const LIFECYCLE_CONFLICT_FIXTURE = {
  error: {
    code: 'LIFECYCLE_CONFLICT',
    message: 'Booking cannot be cancelled in CONFIRMED state',
  },
  reference: VALID_ULID,
};
