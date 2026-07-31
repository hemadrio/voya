/**
 * Unit tests for computeAlternativeDates.
 *
 * Covers: basic range, past-date filtering, edge cases.
 */
import { describe, it, expect } from 'vitest';
import { computeAlternativeDates } from '../../src/domain/alternativeDates.js';

// Fixed "now" so tests are deterministic: 2099-06-10T00:00:00Z
const NOW_MS = Date.UTC(2099, 5, 10, 0, 0, 0); // June 10 2099

describe('computeAlternativeDates', () => {
  it('returns dates symmetrically offset around the departure date', () => {
    const result = computeAlternativeDates('2099-06-15', 3, NOW_MS);
    expect(result).toEqual([
      '2099-06-12',
      '2099-06-13',
      '2099-06-14',
      '2099-06-16',
      '2099-06-17',
      '2099-06-18',
    ]);
  });

  it('excludes the departure date itself', () => {
    const result = computeAlternativeDates('2099-06-15', 3, NOW_MS);
    expect(result).not.toContain('2099-06-15');
  });

  it('excludes past dates', () => {
    // now = June 10, departure = June 12 → June 9/10/11 should be excluded
    const result = computeAlternativeDates('2099-06-12', 3, NOW_MS);
    expect(result).not.toContain('2099-06-09');
    expect(result).not.toContain('2099-06-10');
    expect(result).not.toContain('2099-06-11');
    expect(result).toContain('2099-06-13');
    expect(result).toContain('2099-06-14');
    expect(result).toContain('2099-06-15');
  });

  it('returns sorted ascending', () => {
    const result = computeAlternativeDates('2099-06-15', 3, NOW_MS);
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it('returns an empty array for an invalid date string', () => {
    const result = computeAlternativeDates('not-a-date', 3, NOW_MS);
    expect(result).toEqual([]);
  });

  it('respects a custom offset of 1', () => {
    const result = computeAlternativeDates('2099-06-15', 1, NOW_MS);
    expect(result).toEqual(['2099-06-14', '2099-06-16']);
  });

  it('returns empty array when all offset dates are in the past', () => {
    const nowFarFuture = Date.UTC(2099, 5, 20, 0, 0, 0); // June 20 2099
    const result = computeAlternativeDates('2099-06-15', 3, nowFarFuture);
    // All dates June 12–18 are before June 20
    expect(result).toEqual([]);
  });
});
