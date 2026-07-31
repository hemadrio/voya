/**
 * Integration tests for GET /v1/offers/:id.
 *
 * End-to-end through the Express app using:
 *  - Real OfferResolutionService pipeline
 *  - Fake OfferStore (no Redis)
 *  - Fake clock for expiry control
 *
 * Scenarios (AC8):
 *   1. Fresh offer → 200 with offer + freshness block.
 *   2. Stale offer → 200 with stale:true and indicativeLabel.
 *   3. Expired offer → 410 OFFER_EXPIRED.
 *   4. Unknown id → 404 NOT_FOUND.
 *   5. Malformed id (not 64 hex) → 400 VALIDATION_FAILED.
 *   6. Illustrative provenance → 200 with bookable:false.
 *   7. Clock advanced past expiresAt → transitions from 200 to 410.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createOfferResolutionService } from '../../src/domain/OfferResolutionService.js';
import type { OfferStore } from '../../src/domain/OfferResolutionService.js';
import type { SearchAdapter } from '../../src/adapters/SearchAdapter.js';
import type { OfferIndexEntry } from '@travel/search-cache';

// ---------------------------------------------------------------------------
// Stub SearchAdapter (required by createApp, not used by offer route)
// ---------------------------------------------------------------------------

const STUB_ADAPTER: SearchAdapter = {
  searchFlights: async () => [],
  searchHotels: async () => [],
  searchCars: async () => [],
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const FAR_FUTURE_ISO = '2099-12-31T23:59:59.000Z';
const PAST_ISO = '2020-01-01T00:00:00.000Z';
const NOW_MS = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<OfferIndexEntry> = {}): OfferIndexEntry {
  return {
    offer: {
      id: VALID_ID,
      provenance: 'RAPIDAPI',
      bookable: true,
      price: 120,
      currency: 'USD',
      expiresAt: FAR_FUTURE_ISO,
      details: { supplier: 'RAPIDAPI', vehicleClass: 'ECONOMY', totalPrice: 120 },
    },
    generatedAt: NOW_MS - 1000,
    freshUntil: NOW_MS + 3_600_000,
    category: 'car',
    ...overrides,
  };
}

function makeStore(entry: OfferIndexEntry | null): OfferStore {
  return { getOfferById: async () => entry };
}

function buildApp(store: OfferStore, clockNow: number = NOW_MS) {
  const svc = createOfferResolutionService({
    offerStore: store,
    clock: { now: () => clockNow },
  });
  return createApp(STUB_ADAPTER, svc);
}

// ---------------------------------------------------------------------------
// Scenario 1: Fresh offer
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — fresh offer (scenario 1)', () => {
  it('returns 200 with offer and freshness', async () => {
    const app = buildApp(makeStore(makeEntry()));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.offer).toBeDefined();
    expect(res.body.freshness).toMatchObject({
      stale: false,
      requiresRevalidation: false,
      generatedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it('offer includes id, provenance, bookable, currency fields', async () => {
    const app = buildApp(makeStore(makeEntry()));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.body.offer).toMatchObject({
      id: VALID_ID,
      provenance: 'RAPIDAPI',
      bookable: true,
      currency: 'USD',
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Stale offer
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — stale offer (scenario 2)', () => {
  it('returns 200 with stale:true and indicativeLabel', async () => {
    const staleEntry = makeEntry({
      freshUntil: NOW_MS - 1000, // past freshness
    });
    const app = buildApp(makeStore(staleEntry));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.freshness.stale).toBe(true);
    expect(res.body.freshness.requiresRevalidation).toBe(true);
    expect(typeof res.body.freshness.indicativeLabel).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Expired offer → 410
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — expired offer (scenario 3)', () => {
  it('returns 410 with OFFER_EXPIRED code', async () => {
    const expiredEntry = makeEntry({
      offer: {
        id: VALID_ID,
        provenance: 'RAPIDAPI',
        bookable: true,
        price: 120,
        currency: 'USD',
        expiresAt: PAST_ISO,
      },
    });
    const app = buildApp(makeStore(expiredEntry));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OFFER_EXPIRED');
    expect(res.body.reference).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Unknown id → 404
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — unknown id (scenario 4)', () => {
  it('returns 404 with NOT_FOUND code', async () => {
    const app = buildApp(makeStore(null));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.reference).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Malformed id → 400
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — malformed id (scenario 5)', () => {
  it('returns 400 VALIDATION_FAILED for non-hex id', async () => {
    const app = buildApp(makeStore(null));
    const res = await request(app).get('/v1/offers/not-a-valid-id');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.field).toBe('id');
  });

  it('returns 400 for id that is too short', async () => {
    const app = buildApp(makeStore(null));
    const res = await request(app).get('/v1/offers/abc123');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 400 for id with 63 hex chars (one short)', async () => {
    const shortId = 'a'.repeat(63);
    const app = buildApp(makeStore(null));
    const res = await request(app).get(`/v1/offers/${shortId}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Illustrative provenance → bookable false
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — illustrative offer (scenario 6)', () => {
  it('returns 200 with bookable:false for ILLUSTRATIVE provenance', async () => {
    const illustrativeEntry = makeEntry({
      offer: {
        id: VALID_ID,
        provenance: 'ILLUSTRATIVE',
        bookable: false,
        price: 300,
        currency: 'USD',
        expiresAt: FAR_FUTURE_ISO,
      },
    });
    const app = buildApp(makeStore(illustrativeEntry));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.offer.bookable).toBe(false);
    expect(res.body.offer.provenance).toBe('ILLUSTRATIVE');
  });

  it('forces bookable:false even when stored as true for ILLUSTRATIVE', async () => {
    const illustrativeEntry = makeEntry({
      offer: {
        id: VALID_ID,
        provenance: 'ILLUSTRATIVE',
        bookable: true, // stored incorrectly
        price: 300,
        currency: 'USD',
        expiresAt: FAR_FUTURE_ISO,
      },
    });
    const app = buildApp(makeStore(illustrativeEntry));
    const res = await request(app).get(`/v1/offers/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.offer.bookable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Clock advancement (search-then-resolve-then-expire)
// ---------------------------------------------------------------------------

describe('GET /v1/offers/:id — clock advancement (scenario 7)', () => {
  it('transitions from 200 to 410 when clock advances past expiresAt', async () => {
    const expiresAtMs = NOW_MS + 1000;
    const entry = makeEntry({
      offer: {
        id: VALID_ID,
        provenance: 'RAPIDAPI',
        bookable: true,
        price: 120,
        currency: 'USD',
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });

    // Before expiry — should return 200
    const appBefore = buildApp(makeStore(entry), NOW_MS);
    const resBefore = await request(appBefore).get(`/v1/offers/${VALID_ID}`);
    expect(resBefore.status).toBe(200);

    // After expiry — clock advanced past expiresAt
    const appAfter = buildApp(makeStore(entry), expiresAtMs + 1);
    const resAfter = await request(appAfter).get(`/v1/offers/${VALID_ID}`);
    expect(resAfter.status).toBe(410);
    expect(resAfter.body.error.code).toBe('OFFER_EXPIRED');
  });
});
