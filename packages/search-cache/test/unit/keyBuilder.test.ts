import { describe, it, expect } from '@jest/globals';
import { buildKey, buildKeyHash, buildLockKey, canonicalJson } from '../../src/keyBuilder.js';
import {
  FLIGHT_SEARCH_PARAMS,
  FLIGHT_SEARCH_PARAMS_DIFFERENT,
  FLIGHT_SEARCH_PARAMS_EQUIV,
} from '../fixtures/payloadFixtures.js';

describe('canonicalJson', () => {
  it('sorts object keys alphabetically', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 3 });
    expect(result).toBe(JSON.stringify({ a: 2, m: 3, z: 1 }));
  });

  it('sorts keys recursively in nested objects', () => {
    const result = canonicalJson({ outer: { z: 1, a: 2 }, b: true });
    expect(result).toBe(JSON.stringify({ b: true, outer: { a: 2, z: 1 } }));
  });

  it('upper-cases string values (airport codes, location codes)', () => {
    const result = canonicalJson({ origin: 'jfk', destination: 'lax' });
    expect(result).toBe(JSON.stringify({ destination: 'LAX', origin: 'JFK' }));
  });

  it('trims whitespace from string values', () => {
    const result = canonicalJson({ origin: '  JFK  ', destination: ' LAX ' });
    expect(result).toBe(JSON.stringify({ destination: 'LAX', origin: 'JFK' }));
  });

  it('normalises date strings to YYYY-MM-DD (strips time component)', () => {
    const result = canonicalJson({ date: '2024-03-15T14:30:00Z' });
    expect(result).toBe(JSON.stringify({ date: '2024-03-15' }));
  });

  it('keeps plain YYYY-MM-DD dates unchanged', () => {
    const result = canonicalJson({ date: '2024-03-15' });
    expect(result).toBe(JSON.stringify({ date: '2024-03-15' }));
  });

  it('sorts string arrays so order does not affect the key', () => {
    const a = canonicalJson({ codes: ['LAX', 'JFK', 'ORD'] });
    const b = canonicalJson({ codes: ['ORD', 'JFK', 'LAX'] });
    expect(a).toBe(b);
  });

  it('preserves numeric values unchanged', () => {
    const result = canonicalJson({ passengers: 2, cost: 19999 });
    expect(result).toBe(JSON.stringify({ cost: 19999, passengers: 2 }));
  });

  it('produces the same JSON for semantically identical flight params', () => {
    const a = canonicalJson(FLIGHT_SEARCH_PARAMS);
    const b = canonicalJson(FLIGHT_SEARCH_PARAMS_EQUIV);
    expect(a).toBe(b);
  });
});

describe('buildKeyHash', () => {
  it('produces identical hashes for semantically equivalent params', () => {
    const hashA = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const hashB = buildKeyHash(FLIGHT_SEARCH_PARAMS_EQUIV);
    expect(hashA).toBe(hashB);
  });

  it('produces different hashes for params with different destination', () => {
    const hashA = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const hashB = buildKeyHash(FLIGHT_SEARCH_PARAMS_DIFFERENT);
    expect(hashA).not.toBe(hashB);
  });

  it('returns a 64-character hex string (sha256)', () => {
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('buildKey', () => {
  it('formats as search:{category}:{hash}', () => {
    const hash = 'abc123';
    expect(buildKey('flight', hash)).toBe('search:flight:abc123');
    expect(buildKey('hotel', hash)).toBe('search:hotel:abc123');
    expect(buildKey('car', hash)).toBe('search:car:abc123');
  });
});

describe('buildLockKey', () => {
  it('formats as search:lock:{category}:{hash}', () => {
    const hash = 'abc123';
    expect(buildLockKey('flight', hash)).toBe('search:lock:flight:abc123');
  });

  it('uses the same hash as buildKey for the same params', () => {
    const hash = buildKeyHash(FLIGHT_SEARCH_PARAMS);
    const cacheKey = buildKey('flight', hash);
    const lockKey = buildLockKey('flight', hash);
    expect(lockKey).toBe(cacheKey.replace('search:flight:', 'search:lock:flight:'));
  });
});
