/**
 * Unit tests for vehicleClassMap.
 *
 * Covers: canonical class mapping, all four classes, UNKNOWN fallback,
 * string normalisation, punctuation stripping, first-token-match semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  mapVehicleClass,
  normaliseDescription,
  VEHICLE_CLASS_TOKENS,
} from '../../src/adapters/mappers/vehicleClassMap.js';

// ---------------------------------------------------------------------------
// normaliseDescription
// ---------------------------------------------------------------------------

describe('normaliseDescription', () => {
  it('lowercases and splits basic description', () => {
    expect(normaliseDescription('Economy Compact')).toEqual(['economy', 'compact']);
  });

  it('strips hyphens and converts to separate tokens', () => {
    expect(normaliseDescription('Full-Size SUV')).toEqual(['full', 'size', 'suv']);
  });

  it('strips parentheses and "or similar" marketing text', () => {
    expect(normaliseDescription('Intermediate (or similar)')).toEqual(['intermediate', 'or', 'similar']);
  });

  it('strips commas, slashes, and other punctuation', () => {
    expect(normaliseDescription('Economy/Compact, Small')).toEqual(['economy', 'compact', 'small']);
  });

  it('handles multiple consecutive spaces', () => {
    expect(normaliseDescription('Premium  SUV')).toEqual(['premium', 'suv']);
  });

  it('returns empty array for empty string', () => {
    expect(normaliseDescription('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapVehicleClass — canonical class coverage
// ---------------------------------------------------------------------------

describe('mapVehicleClass — ECONOMY', () => {
  it('maps "Economy" → ECONOMY', () => {
    expect(mapVehicleClass('Economy')).toBe('ECONOMY');
  });

  it('maps "Mini" → ECONOMY', () => {
    expect(mapVehicleClass('Mini')).toBe('ECONOMY');
  });

  it('maps "Subcompact Car" → ECONOMY', () => {
    expect(mapVehicleClass('Subcompact Car')).toBe('ECONOMY');
  });

  it('maps "Economy Compact" → ECONOMY (first-token-match: economy wins)', () => {
    expect(mapVehicleClass('Economy Compact')).toBe('ECONOMY');
  });

  it('maps "Small Economy" → ECONOMY (small token)', () => {
    expect(mapVehicleClass('Small Economy')).toBe('ECONOMY');
  });
});

describe('mapVehicleClass — COMPACT', () => {
  it('maps "Compact" → COMPACT', () => {
    expect(mapVehicleClass('Compact')).toBe('COMPACT');
  });

  it('maps "Intermediate" → COMPACT', () => {
    expect(mapVehicleClass('Intermediate')).toBe('COMPACT');
  });

  it('maps "Intermediate SUV or similar" → COMPACT (first-match: intermediate)', () => {
    expect(mapVehicleClass('Intermediate SUV or similar')).toBe('COMPACT');
  });

  it('maps "Standard Sedan" → COMPACT', () => {
    expect(mapVehicleClass('Standard Sedan')).toBe('COMPACT');
  });
});

describe('mapVehicleClass — MIDSIZE', () => {
  it('maps "Midsize" → MIDSIZE', () => {
    expect(mapVehicleClass('Midsize')).toBe('MIDSIZE');
  });

  it('maps "Full-Size Sedan" → MIDSIZE (full token)', () => {
    expect(mapVehicleClass('Full-Size Sedan')).toBe('MIDSIZE');
  });

  it('maps "Medium Car" → MIDSIZE', () => {
    expect(mapVehicleClass('Medium Car')).toBe('MIDSIZE');
  });

  it('maps "Regular" → MIDSIZE', () => {
    expect(mapVehicleClass('Regular')).toBe('MIDSIZE');
  });
});

describe('mapVehicleClass — PREMIUM', () => {
  it('maps "Premium" → PREMIUM', () => {
    expect(mapVehicleClass('Premium')).toBe('PREMIUM');
  });

  it('maps "Luxury Sedan" → PREMIUM', () => {
    expect(mapVehicleClass('Luxury Sedan')).toBe('PREMIUM');
  });

  it('maps "SUV" → PREMIUM', () => {
    expect(mapVehicleClass('SUV')).toBe('PREMIUM');
  });

  it('maps "Premium SUV" → PREMIUM', () => {
    expect(mapVehicleClass('Premium SUV')).toBe('PREMIUM');
  });

  it('maps "Executive Saloon" → PREMIUM', () => {
    expect(mapVehicleClass('Executive Saloon')).toBe('PREMIUM');
  });

  it('maps "Convertible Sports" → PREMIUM', () => {
    expect(mapVehicleClass('Convertible Sports')).toBe('PREMIUM');
  });
});

describe('mapVehicleClass — UNKNOWN fallback', () => {
  it('returns UNKNOWN for deliberately unmappable description', () => {
    expect(mapVehicleClass('Motorsport Cabriolet Turbo')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for empty string', () => {
    expect(mapVehicleClass('')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for description with only stopwords', () => {
    expect(mapVehicleClass('or similar')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for gibberish', () => {
    expect(mapVehicleClass('Superjumbo Hyperspace Cruiser')).toBe('UNKNOWN');
  });

  it('never defaults UNKNOWN to any class', () => {
    const result = mapVehicleClass('Zeppelin Airship XL');
    expect(result).toBe('UNKNOWN');
    expect(result).not.toBe('ECONOMY');
    expect(result).not.toBe('COMPACT');
    expect(result).not.toBe('MIDSIZE');
    expect(result).not.toBe('PREMIUM');
  });
});

// ---------------------------------------------------------------------------
// VEHICLE_CLASS_TOKENS table completeness
// ---------------------------------------------------------------------------

describe('VEHICLE_CLASS_TOKENS', () => {
  it('contains entries for all four canonical classes', () => {
    const classes = new Set(VEHICLE_CLASS_TOKENS.values());
    expect(classes.has('ECONOMY')).toBe(true);
    expect(classes.has('COMPACT')).toBe(true);
    expect(classes.has('MIDSIZE')).toBe(true);
    expect(classes.has('PREMIUM')).toBe(true);
  });

  it('all tokens are lowercase (normalised)', () => {
    for (const key of VEHICLE_CLASS_TOKENS.keys()) {
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toMatch(/[^a-z0-9]/); // no punctuation
    }
  });
});
