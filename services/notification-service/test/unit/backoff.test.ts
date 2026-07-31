/**
 * Unit tests for the backoff module.
 */
import { describe, it, expect } from 'vitest';
import {
  computeBackoffMs,
  isRetryable,
  MAX_DELIVERY_ATTEMPTS,
  DEFAULT_BACKOFF,
  SesThrottlingError,
  SesServiceUnavailableError,
  SesPermanentRejectionError,
  TransientDbError,
  TransientRedisError,
  PayloadValidationError,
  UnknownEventTypeError,
} from '../../src/domain/backoff.js';

describe('computeBackoffMs', () => {
  it('returns 0 when random returns 0', () => {
    expect(computeBackoffMs(0, DEFAULT_BACKOFF, () => 0)).toBe(0);
    expect(computeBackoffMs(3, DEFAULT_BACKOFF, () => 0)).toBe(0);
  });

  it('grows exponentially with attempt', () => {
    const fixed = () => 1; // max jitter
    const attempt0 = computeBackoffMs(0, DEFAULT_BACKOFF, fixed);
    const attempt1 = computeBackoffMs(1, DEFAULT_BACKOFF, fixed);
    const attempt2 = computeBackoffMs(2, DEFAULT_BACKOFF, fixed);
    // base=250, attempt=0: 250*1=250; attempt=1: 250*2=500; attempt=2: 250*4=1000
    expect(attempt0).toBe(250);
    expect(attempt1).toBe(500);
    expect(attempt2).toBe(1000);
  });

  it('caps at capMs', () => {
    const fixed = () => 1;
    const config = { baseMs: 1000, capMs: 5000 };
    // attempt=10: 1000 * 2^10 = 1_024_000 → capped at 5000
    const result = computeBackoffMs(10, config, fixed);
    expect(result).toBe(5000);
  });

  it('applies jitter (output is less than exponential * jitter factor)', () => {
    const halfJitter = () => 0.5;
    const config = { baseMs: 1000, capMs: 100_000 };
    // attempt=1: 1000 * 2 = 2000, * 0.5 = 1000
    expect(computeBackoffMs(1, config, halfJitter)).toBe(1000);
  });

  it('returns integer value (floor applied)', () => {
    const result = computeBackoffMs(0, { baseMs: 100, capMs: 10_000 }, () => 0.333);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('MAX_DELIVERY_ATTEMPTS is 5', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
  });
});

describe('isRetryable', () => {
  it('classifies SesThrottlingError as retryable', () => {
    expect(isRetryable(new SesThrottlingError('throttled'))).toBe(true);
  });

  it('classifies SesServiceUnavailableError as retryable', () => {
    expect(isRetryable(new SesServiceUnavailableError('unavailable'))).toBe(true);
  });

  it('classifies TransientDbError as retryable', () => {
    expect(isRetryable(new TransientDbError('db down'))).toBe(true);
  });

  it('classifies TransientRedisError as retryable', () => {
    expect(isRetryable(new TransientRedisError('redis down'))).toBe(true);
  });

  it('classifies SesPermanentRejectionError as NOT retryable', () => {
    expect(isRetryable(new SesPermanentRejectionError('rejected'))).toBe(false);
  });

  it('classifies PayloadValidationError as NOT retryable', () => {
    expect(isRetryable(new PayloadValidationError('bad payload'))).toBe(false);
  });

  it('classifies UnknownEventTypeError as NOT retryable', () => {
    expect(isRetryable(new UnknownEventTypeError('unknown'))).toBe(false);
  });

  it('classifies generic Error as NOT retryable', () => {
    expect(isRetryable(new Error('generic'))).toBe(false);
  });

  it('classifies non-Error as NOT retryable', () => {
    expect(isRetryable('string error')).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});
