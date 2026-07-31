/**
 * Integration tests for the illustrative offer generation path.
 *
 * Simulates "all suppliers unavailable" under both flag states and verifies:
 *   - Flag enabled  + supplier unavailable → labelled non-bookable offers + audit record
 *   - Flag disabled + supplier unavailable → empty state, zero illustrative offers
 *   - Flag enabled  + suppliers available  → empty state (gating suppresses generation)
 *
 * No real supplier HTTP calls are made.  All I/O is handled by fakes.
 */

import { IllustrativeOfferGenerator } from '../../src/IllustrativeOfferGenerator.js';
import { evaluateGating } from '../../src/gating.js';
import { FakeFeatureFlagProvider } from '../fakes/FakeFeatureFlagProvider.js';
import { FakeAuditWriter } from '../fakes/FakeAuditWriter.js';
import { ILLUSTRATIVE_FLAG_KEY } from '../../src/types.js';
import type { SearchCriteria } from '@travel/supplier-port';

jest.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: jest.fn() }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV = 'dev';
const PROD = 'production';
const HARD_DISABLED = [PROD];

const FLIGHT_CRITERIA: SearchCriteria = {
  kind: 'flight',
  departureAirport: 'LHR',
  arrivalAirport: 'JFK',
  departureDate: new Date('2028-03-15T00:00:00Z'),
  passengers: 2,
  seatClass: 'ECONOMY',
  currency: 'USD',
};

function makeSearchPath(opts: {
  environment: string;
  flagEnabled: boolean;
}) {
  const flagProvider = new FakeFeatureFlagProvider({
    [ILLUSTRATIVE_FLAG_KEY]: opts.flagEnabled,
  });
  const auditWriter = new FakeAuditWriter();

  const generator = new IllustrativeOfferGenerator({
    featureFlagProvider: flagProvider,
    auditWriter,
    config: {
      environment: opts.environment,
      hardDisabledEnvironments: HARD_DISABLED,
      actorIdentifier: 'search-service',
      defaultValidityMinutes: 30,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    clock: { now: () => 1_700_000_000_000 },
  });

  return { flagProvider, auditWriter, generator };
}

async function simulateSearch(
  opts: {
    environment: string;
    flagEnabled: boolean;
    supplierWasUnavailable: boolean;
  },
  criteria: SearchCriteria,
  correlationId: string,
) {
  const { flagProvider, auditWriter, generator } = makeSearchPath({
    environment: opts.environment,
    flagEnabled: opts.flagEnabled,
  });

  const flagEnabled = await flagProvider.isEnabled(ILLUSTRATIVE_FLAG_KEY, opts.environment);
  const gating = evaluateGating({
    environment: opts.environment,
    hardDisabledEnvironments: HARD_DISABLED,
    flagEnabled,
    supplierWasUnavailable: opts.supplierWasUnavailable,
  });

  let offers: ReadonlyArray<import('@travel/contracts').Offer> = [];
  if (gating.decision === 'allow') {
    offers = await generator.searchOffers(criteria, correlationId);
  }

  return { offers, auditWriter, gating };
}

// ---------------------------------------------------------------------------
// Scenario 1: all suppliers down, flag enabled
// ---------------------------------------------------------------------------

describe('Integration: all suppliers unavailable, flag ENABLED', () => {
  it('produces illustrative offers', async () => {
    const { offers } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-1',
    );
    expect(offers.length).toBeGreaterThan(0);
  });

  it('every offer is labelled ILLUSTRATIVE and non-bookable', async () => {
    const { offers } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-2',
    );
    for (const offer of offers) {
      expect(offer.provenance).toBe('ILLUSTRATIVE');
      expect(offer.bookable).toBe(false);
    }
  });

  it('writes an audit record', async () => {
    const { auditWriter } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-3',
    );
    expect(auditWriter.records).toHaveLength(1);
    expect(auditWriter.records[0]!.type).toBe('ILLUSTRATIVE_OFFERS_SERVED');
    expect(auditWriter.records[0]!.correlationId).toBe('corr-int-3');
  });

  it('gating decision is allow', async () => {
    const { gating } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-4',
    );
    expect(gating.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: all suppliers down, flag DISABLED
// ---------------------------------------------------------------------------

describe('Integration: all suppliers unavailable, flag DISABLED', () => {
  it('returns empty offer set', async () => {
    const { offers } = await simulateSearch(
      { environment: DEV, flagEnabled: false, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-5',
    );
    expect(offers).toHaveLength(0);
  });

  it('writes no audit records', async () => {
    const { auditWriter } = await simulateSearch(
      { environment: DEV, flagEnabled: false, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-6',
    );
    expect(auditWriter.records).toHaveLength(0);
  });

  it('gating decision is suppress with reason flag_disabled', async () => {
    const { gating } = await simulateSearch(
      { environment: DEV, flagEnabled: false, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-7',
    );
    expect(gating.decision).toBe('suppress');
    expect(gating.reason).toBe('flag_disabled');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: suppliers available, flag enabled — generator must NOT run
// ---------------------------------------------------------------------------

describe('Integration: suppliers available, flag ENABLED', () => {
  it('returns empty offer set (generator should not supplement successful responses)', async () => {
    const { offers } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: false },
      FLIGHT_CRITERIA,
      'corr-int-8',
    );
    expect(offers).toHaveLength(0);
  });

  it('gating decision is suppress with reason suppliers_available', async () => {
    const { gating } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: false },
      FLIGHT_CRITERIA,
      'corr-int-9',
    );
    expect(gating.decision).toBe('suppress');
    expect(gating.reason).toBe('suppliers_available');
  });

  it('writes no audit records', async () => {
    const { auditWriter } = await simulateSearch(
      { environment: DEV, flagEnabled: true, supplierWasUnavailable: false },
      FLIGHT_CRITERIA,
      'corr-int-10',
    );
    expect(auditWriter.records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: production + hard-disabled + flag enabled → zero offers
// ---------------------------------------------------------------------------

describe('Integration: production hard-disabled', () => {
  it('returns zero offers in production regardless of flag state', async () => {
    const { offers } = await simulateSearch(
      { environment: PROD, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-prod',
    );
    expect(offers).toHaveLength(0);
  });

  it('gating suppresses with hard_disabled reason', async () => {
    const { gating } = await simulateSearch(
      { environment: PROD, flagEnabled: true, supplierWasUnavailable: true },
      FLIGHT_CRITERIA,
      'corr-int-prod-2',
    );
    expect(gating.decision).toBe('suppress');
    expect(gating.reason).toBe('hard_disabled');
  });
});
