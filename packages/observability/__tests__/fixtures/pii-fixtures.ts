/**
 * Synthetic PII fixtures — no real personal data.
 * Used by redaction tests to assert raw sensitive values never appear in output.
 */

export const PII_FIXTURES = {
  /** Synthetic traveler record with all redactable fields. */
  traveler: {
    id: 'traveler-001',
    email: 'maya.traveler@example.com',
    dateOfBirth: '1990-05-15',
    passportNumber: 'X12345678',
    name: 'Maya Traveler',
  },

  /** Second traveler for array-element tests. */
  travelerTwo: {
    id: 'traveler-002',
    email: 'devan.business@example.com',
    dateOfBirth: '1985-11-22',
    passportNumber: 'Y87654321',
    name: 'Devan Business',
  },

  /** Offer snapshot with a traveler nested three levels deep. */
  offerSnapshot: {
    offerId: 'offer-abc-123',
    booking: {
      legs: [
        {
          traveler: {
            email: 'nested.deep@example.com',
            passportNumber: 'Z11111111',
          },
        },
      ],
    },
  },

  /** passwordHash field. */
  credentials: {
    userId: 'user-001',
    passwordHash: '$2b$12$FAKEHASHFORTHISPASSWORD.notreal',
  },
} as const;

/** Synthetic HTTP header set including auth tokens and Stripe signature. */
export const HEADER_FIXTURES = {
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.FAKE',
    'stripe-signature': 't=1234567890,v1=FAKESIGNATUREHEX',
    'x-correlation-id': 'corr-001',
  },
} as const;

/** Error whose message and stack embed an email and a passport number. */
export class PiiError extends Error {
  constructor() {
    super(
      'Validation failed for traveler pii.embed@example.com with passport A99887766'
    );
    this.name = 'PiiError';
    // Ensure the stack includes the PII so the serializer scrubber is exercised.
    this.stack =
      `PiiError: Validation failed for traveler pii.embed@example.com with passport A99887766\n` +
      `    at Object.<anonymous> (/app/src/validator.ts:42:15)\n` +
      `    at Module._compile (node:internal/modules/cjs/loader:1376:14)`;
  }
}

export const PII_ERROR_FIXTURE = new PiiError();

/** Raw PII values that must NOT appear in any serialized log line. */
export const SENSITIVE_VALUES = [
  'maya.traveler@example.com',
  'devan.business@example.com',
  'nested.deep@example.com',
  'pii.embed@example.com',
  'X12345678',
  'Y87654321',
  'Z11111111',
  'A99887766',
  '$2b$12$FAKEHASHFORTHISPASSWORD.notreal',
  '1990-05-15',
  '1985-11-22',
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.FAKE',
  'FAKESIGNATUREHEX',
] as const;
