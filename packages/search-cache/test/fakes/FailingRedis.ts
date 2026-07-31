import type { SearchCacheRedisClient } from '../../src/types.js';

/**
 * Failing Redis double — every operation throws a connection-refused error.
 *
 * Used in degradation-path unit tests to exercise the CacheHealthState
 * transitions and the no-op behaviour of SearchCacheRepository when Redis
 * is unavailable.
 *
 * Committed as a fixture (AC9) so the degradation path is testable without
 * infrastructure manipulation.
 */
export class FailingRedis implements SearchCacheRedisClient {
  /** Number of times each method was called — useful for assertion counts. */
  getCalls = 0;
  setexCalls = 0;
  setNxPxCalls = 0;
  delCalls = 0;

  private readonly _error: Error;

  constructor(message = 'connect ECONNREFUSED 127.0.0.1:6379') {
    this._error = new Error(message);
    this._error.name = 'RedisConnectionError';
  }

  async get(_key: string): Promise<string | null> {
    this.getCalls++;
    throw this._error;
  }

  async setex(_key: string, _seconds: number, _value: string): Promise<'OK'> {
    this.setexCalls++;
    throw this._error;
  }

  async setNxPx(_key: string, _value: string, _milliseconds: number): Promise<boolean> {
    this.setNxPxCalls++;
    throw this._error;
  }

  async del(_key: string): Promise<number> {
    this.delCalls++;
    throw this._error;
  }

  async pttl(_key: string): Promise<number> {
    throw this._error;
  }

  reset(): void {
    this.getCalls = 0;
    this.setexCalls = 0;
    this.setNxPxCalls = 0;
    this.delCalls = 0;
  }
}
