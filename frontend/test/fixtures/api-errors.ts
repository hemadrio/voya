/**
 * Fixture backend error payloads covering all error codes the frontend handles.
 *
 * Each fixture matches the ErrorEnvelope schema from @travel/contracts/errors.
 * Use these in MSW handlers to assert that the API client produces the correct
 * normalized ApiError shape.
 */

export const ERROR_400_VALIDATION = {
  error: {
    code: "VALIDATION_FAILED",
    message: "departureAirport must be a valid 3-letter IATA code",
    field: "departureAirport",
    fieldErrors: {
      departureAirport: "Must be a valid 3-letter IATA code",
    },
  },
  reference: "fixture-400-validation",
} as const;

export const ERROR_400_MULTI_FIELD = {
  error: {
    code: "VALIDATION_FAILED",
    message: "Multiple validation errors",
    fieldErrors: {
      departureAirport: "Required",
      departureDate: "Must be a future date",
      passengers: "At least one passenger required",
    },
  },
  reference: "fixture-400-multi-field",
} as const;

export const ERROR_401_UNAUTHORIZED = {
  error: {
    code: "UNAUTHORIZED",
    message: "Authentication required. Please sign in to continue.",
  },
  reference: "fixture-401-unauthorized",
} as const;

export const ERROR_403_FORBIDDEN = {
  error: {
    code: "FORBIDDEN",
    message: "You do not have permission to perform this action.",
  },
  reference: "fixture-403-forbidden",
} as const;

export const ERROR_404_NOT_FOUND = {
  error: {
    code: "NOT_FOUND",
    message: "The requested offer was not found or has expired.",
  },
  reference: "fixture-404-not-found",
} as const;

export const ERROR_409_CONFLICT = {
  error: {
    code: "CONFLICT",
    message: "This booking already exists.",
  },
  reference: "fixture-409-conflict",
} as const;

export const ERROR_500_INTERNAL = {
  error: {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred. Please try again.",
  },
  reference: "fixture-500-internal",
} as const;

export const ERROR_502_BAD_GATEWAY = {
  error: {
    code: "BAD_GATEWAY",
    message: "Upstream supplier is temporarily unavailable.",
  },
  reference: "fixture-502-bad-gateway",
} as const;

export const ERROR_503_UNAVAILABLE = {
  error: {
    code: "SERVICE_UNAVAILABLE",
    message: "Service is temporarily unavailable. Please try again shortly.",
  },
  reference: "fixture-503-unavailable",
} as const;
