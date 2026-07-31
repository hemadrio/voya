/**
 * Typed API error hierarchy for the travel platform web client.
 *
 * All non-2xx backend responses and network failures are normalized into
 * ApiError so every caller handles a single, predictable shape.
 */

export const ApiErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNPROCESSABLE: "UNPROCESSABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  BAD_GATEWAY: "BAD_GATEWAY",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface FieldErrors {
  [field: string]: string;
}

/**
 * Thrown by the API client for any non-2xx response or network failure.
 * Carries the HTTP status, a machine-readable code, a human message,
 * and optional per-field validation errors.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors: FieldErrors | undefined;
  readonly retryable: boolean;

  constructor(options: {
    status: number;
    code: ApiErrorCode;
    message: string;
    fieldErrors?: FieldErrors | undefined;
    retryable?: boolean | undefined;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.retryable = options.retryable ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static fromStatus(status: number, message: string, fieldErrors?: FieldErrors): ApiError {
    const code = statusToCode(status);
    const retryable = status === 503 || status === 429 || status === 502;
    return new ApiError({ status, code, message, fieldErrors, retryable });
  }

  static networkError(message = "Network request failed"): ApiError {
    return new ApiError({
      status: 0,
      code: ApiErrorCode.NETWORK_ERROR,
      message,
      retryable: true,
    });
  }
}

function statusToCode(status: number): ApiErrorCode {
  if (status === 400) return ApiErrorCode.VALIDATION_FAILED;
  if (status === 401) return ApiErrorCode.UNAUTHORIZED;
  if (status === 403) return ApiErrorCode.FORBIDDEN;
  if (status === 404) return ApiErrorCode.NOT_FOUND;
  if (status === 409) return ApiErrorCode.CONFLICT;
  if (status === 422) return ApiErrorCode.UNPROCESSABLE;
  if (status === 502) return ApiErrorCode.BAD_GATEWAY;
  if (status === 503) return ApiErrorCode.SERVICE_UNAVAILABLE;
  if (status >= 500) return ApiErrorCode.INTERNAL_ERROR;
  return ApiErrorCode.UNKNOWN;
}
