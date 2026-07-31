/**
 * Unit tests for OfferResolutionService.
 *
 * Covers (AC7 + AC8):
 *  - FRESH resolve returns offer + freshness with stale:false
 *  - STALE resolve returns offer + freshness with stale:true, requiresRevalidation:true
 *  - EXPIRED returns EXPIRED outcome (no offer)
 *  - NOT_FOUND returns NOT_FOUND outcome (unknown id)
 *  - ILLUSTRATIVE offers resolve with bookable:false (via controller — service just returns the offer)
 *  - requiresRevalidation is true when near expiry (within revalidationWindowMs)
 *  - Clock is injectable and controls all expiry decisions
 */

import { describe, it, expect } from 'vitest';
import { createOfferResolutionService } from '../../src/domain/OfferResolutionService.js';
import type { OfferStore } from '../../src/domain/OfferResolutionService.js';
import type { OfferIndexEntry } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAR_FUTURE_MS = 4070908800000; // 2099-01-01 in ms
const FAR_FUTURE_ISO = new Date(FAR_FUTURE_MS).toISOString();

const VALID_OFFER_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<OfferIndexEntry> = {}): OfferIndexEntry {
  const nowMs = 1_700_000_000_000;
  return {
    offer: {
      id: VALID_OFFER_ID,
      provenance: 'RAPIDAPI',
      bookable: true,
      price: 120,
      currency: 'USD',
      expiresAt: FAR_FUTURE_ISO,
    },
    generatedAt: nowMs,
    freshUntil: nowMs + 3_600_000, // fresh for 1 hour
    category: 'car',
    ...overrides,
  };
}

function makeStore(entry: OfferIndexEntry | null = null): OfferStore {
  return {
    getOfferById: async (_id: string) => entry,
  };
}

// ---------------------------------------------------------------------------
// NOT_FOUND
// ---------------------------------------------------------------------------

describe('OfferResolutionService — NOT_FOUND', () => {
  it('returns NOT_FOUND when store has no entry', async () => {
    const svc = createOfferResolutionService({
      offerStore: makeStore(null),
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('NOT_FOUND');
    expect(result.offer).toBeUndefined();
    expect(result.freshness).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EXPIRED
// ---------------------------------------------------------------------------

describe('OfferResolutionService — EXPIRED', () => {
  it('returns EXPIRED when expiresAt is in the past', async () => {
    const pastExpiresAt = '2020-01-01T00:00:00.000Z';
    const entry = makeEntry({ offer: { id: VALID_OFFER_ID, expiresAt: pastExpiresAt, provenance: 'RAPIDAPI', bookable: true, price: 120, currency: 'USD' } });
    const svc = createOfferResolutionService({ offerStore: makeStore(entry) });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('EXPIRED');
    expect(result.offer).toBeUndefined();
  });

  it('returns EXPIRED when expiresAt equals now (boundary)', async () => {
    const nowMs = 1_700_000_000_000;
    const entry = makeEntry({
      offer: {
        id: VALID_OFFER_ID,
        expiresAt: new Date(nowMs).toISOString(),
        provenance: 'RAPIDAPI', bookable: true, price: 120, currency: 'USD',
      },
    });
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('EXPIRED');
  });

  it('returns EXPIRED when offer has no expiresAt field', async () => {
    const entry = makeEntry({ offer: { id: VALID_OFFER_ID, provenance: 'RAPIDAPI', bookable: true, price: 120, currency: 'USD' } });
    const svc = createOfferResolutionService({ offerStore: makeStore(entry) });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// FRESH
// ---------------------------------------------------------------------------

describe('OfferResolutionService — FRESH', () => {
  it('returns FRESH with offer and freshness when within freshness window', async () => {
    const nowMs = 1_700_000_000_000;
    const entry = makeEntry({
      generatedAt: nowMs - 1000,
      freshUntil: nowMs + 3_600_000,
    });
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('FRESH');
    expect(result.offer).toBeDefined();
    expect(result.freshness?.stale).toBe(false);
  });

  it('freshness.generatedAt matches entry generatedAt', async () => {
    const nowMs = 1_700_000_000_000;
    const entry = makeEntry({ generatedAt: nowMs - 5000 });
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.freshness?.generatedAt.getTime()).toBe(nowMs - 5000);
  });

  it('freshness.expiresAt matches offer expiresAt', async () => {
    const nowMs = 1_700_000_000_000;
    const entry = makeEntry();
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.freshness?.expiresAt.toISOString()).toBe(FAR_FUTURE_ISO);
  });

  it('requiresRevalidation is false when offer is fresh and far from expiry', async () => {
    const nowMs = 1_700_000_000_000;
    const entry = makeEntry();
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.freshness?.requiresRevalidation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STALE
// ---------------------------------------------------------------------------

describe('OfferResolutionService — STALE', () => {
  it('returns STALE when past freshUntil but offer not expired', async () => {
    const nowMs = 1_700_010_000_000;
    const entry = makeEntry({
      generatedAt: 1_700_000_000_000,
      freshUntil: nowMs - 1000, // in the past
    });
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('STALE');
    expect(result.freshness?.stale).toBe(true);
    expect(result.freshness?.requiresRevalidation).toBe(true);
    expect(result.offer).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Near-expiry requiresRevalidation (BR-05)
// ---------------------------------------------------------------------------

describe('OfferResolutionService — requiresRevalidation near expiry', () => {
  it('sets requiresRevalidation true when expiresAt is within revalidationWindowMs', async () => {
    const revalidationWindowMs = 5 * 60 * 1000;
    const nowMs = 1_700_000_000_000;
    const expiresAtMs = nowMs + revalidationWindowMs - 1; // 1ms inside window
    const entry = makeEntry({
      generatedAt: nowMs - 1000,
      freshUntil: nowMs + 3_600_000,
      offer: {
        id: VALID_OFFER_ID,
        provenance: 'RAPIDAPI',
        bookable: true,
        price: 120,
        currency: 'USD',
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
    const svc = createOfferResolutionService({
      offerStore: makeStore(entry),
      clock: { now: () => nowMs },
      revalidationWindowMs,
    });
    const result = await svc.resolve(VALID_OFFER_ID);
    expect(result.outcome).toBe('FRESH');
    expect(result.freshness?.requiresRevalidation).toBe(true);
  });
});
