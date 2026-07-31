/**
 * Capped exponential backoff with full jitter.
 *
 * Formula: delay = min(base * 2^attempt, cap) * random(0, 1)
 *
 * At 5 attempts the consumer surrenders and calls nack(false) to route the
 * message to the DLQ, raising the DLQ depth alarm.
 */

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface BackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 250,
  capMs: 30_000,
};

export function computeBackoffMs(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = config.baseMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, config.capMs);
  return Math.floor(capped * random());
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof SesThrottlingError) return true;
  if (err instanceof SesServiceUnavailableError) return true;
  if (err instanceof TransientDbError) return true;
  if (err instanceof TransientRedisError) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Typed error classes so callers can throw/catch with instanceof
// ---------------------------------------------------------------------------

export class SesThrottlingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesThrottlingError';
  }
}

export class SesServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesServiceUnavailableError';
  }
}

export class SesPermanentRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesPermanentRejectionError';
  }
}

export class TransientDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientDbError';
  }
}

export class TransientRedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientRedisError';
  }
}

export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadValidationError';
  }
}

export class UnknownEventTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownEventTypeError';
  }
}
