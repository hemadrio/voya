/**
 * IllustrativeOfferGenerator — SupplierPort adapter that produces deterministic
 * non-bookable illustrative offers for dev and demo environments.
 *
 * Gating (defence-in-depth — also enforced by the caller via gating.ts):
 *   1. Hard-disable list checked first — if the current environment is listed,
 *      searchOffers() returns [] regardless of flag state.
 *   2. Feature flag checked — flag errors are treated as disabled (fail safe).
 *   3. Audit write attempted — if the write fails, the generator fails closed
 *      (returns [] and emits an alertable error log).
 *
 * Determinism:
 *   Offers are seeded from a SHA-256 fingerprint of the search criteria so
 *   the same query always produces the same offer set, making tests and demos
 *   reproducible.
 *
 * Observability:
 *   Counter "illustrative_offers_served_total" with dimensions {environment,
 *   category} is incremented on every successful serve.  A CloudWatch alarm
 *   on a non-zero value in production provides alerting for any unintended
 *   production exposure.
 */

import { createHash } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import type { Offer } from '@travel/contracts';
import type { SupplierPort, SupplierFlowShape, SearchCriteria } from '@travel/supplier-port';
import type {
  FeatureFlagProvider,
  AuditWriter,
  IllustrativeGeneratorConfig,
  MinimalLogger,
} from './types.js';
import { ILLUSTRATIVE_FLAG_KEY } from './types.js';

// ---------------------------------------------------------------------------
// Per-category offer templates (prices in USD)
// ---------------------------------------------------------------------------

interface OfferTemplate {
  title: string;
  basePrice: number;
  details: Record<string, unknown>;
}

const FLIGHT_TEMPLATES: ReadonlyArray<OfferTemplate> = [
  {
    title: 'Illustrative Economy Flight',
    basePrice: 249,
    details: { cabinClass: 'ECONOMY', stops: 0, durationMinutes: 180 },
  },
  {
    title: 'Illustrative Business Class Flight',
    basePrice: 699,
    details: { cabinClass: 'BUSINESS', stops: 0, durationMinutes: 180 },
  },
  {
    title: 'Illustrative Connecting Flight',
    basePrice: 189,
    details: { cabinClass: 'ECONOMY', stops: 1, durationMinutes: 300 },
  },
];

const HOTEL_TEMPLATES: ReadonlyArray<OfferTemplate> = [
  {
    title: 'Illustrative Standard Hotel',
    basePrice: 99,
    details: { rating: 3, nights: 1, reviewScore: 7.5 },
  },
  {
    title: 'Illustrative Boutique Hotel',
    basePrice: 169,
    details: { rating: 4, nights: 1, reviewScore: 8.2 },
  },
  {
    title: 'Illustrative Luxury Hotel',
    basePrice: 299,
    details: { rating: 5, nights: 1, reviewScore: 9.1 },
  },
];

const CAR_TEMPLATES: ReadonlyArray<OfferTemplate> = [
  {
    title: 'Illustrative Economy Car',
    basePrice: 35,
    details: { vehicleClass: 'ECONOMY', rentalDays: 1 },
  },
  {
    title: 'Illustrative Compact Car',
    basePrice: 55,
    details: { vehicleClass: 'COMPACT', rentalDays: 1 },
  },
  {
    title: 'Illustrative Premium SUV',
    basePrice: 89,
    details: { vehicleClass: 'PREMIUM', rentalDays: 1 },
  },
];

const TEMPLATES_BY_KIND: Record<string, ReadonlyArray<OfferTemplate>> = {
  flight: FLIGHT_TEMPLATES,
  hotel: HOTEL_TEMPLATES,
  car: CAR_TEMPLATES,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSearchFingerprint(criteria: SearchCriteria): Buffer {
  const key = JSON.stringify({
    kind: criteria.kind,
    currency: criteria.currency,
    ...(criteria.kind === 'flight'
      ? {
          departure: criteria.departureAirport,
          arrival: criteria.arrivalAirport,
          date: criteria.departureDate instanceof Date
            ? criteria.departureDate.toISOString().slice(0, 10)
            : String(criteria.departureDate).slice(0, 10),
        }
      : criteria.kind === 'hotel'
      ? {
          location: criteria.location,
          checkIn: criteria.checkInDate instanceof Date
            ? criteria.checkInDate.toISOString().slice(0, 10)
            : String(criteria.checkInDate).slice(0, 10),
        }
      : {
          pickup: criteria.pickupLocation,
          dropoff: criteria.dropoffLocation,
          pickupDate: criteria.pickupDate instanceof Date
            ? criteria.pickupDate.toISOString().slice(0, 10)
            : String(criteria.pickupDate).slice(0, 10),
        }),
  });
  return createHash('sha256').update(key).digest();
}

function makeOfferId(kind: string, index: number, fingerprintHex: string): string {
  return createHash('sha256')
    .update(`ILLUSTRATIVE:${kind}:${index}:${fingerprintHex}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// IllustrativeOfferGenerator
// ---------------------------------------------------------------------------

export class IllustrativeOfferGenerator implements SupplierPort {
  readonly supplierName = 'ILLUSTRATIVE';
  readonly supportedFlows: ReadonlyArray<SupplierFlowShape> = ['INSTANT'];

  private readonly featureFlagProvider: FeatureFlagProvider;
  private readonly auditWriter: AuditWriter;
  private readonly config: IllustrativeGeneratorConfig;
  private readonly logger: MinimalLogger;
  private readonly clock: { now(): number };
  private readonly counter: Counter;

  constructor(opts: {
    featureFlagProvider: FeatureFlagProvider;
    auditWriter: AuditWriter;
    config: IllustrativeGeneratorConfig;
    logger: MinimalLogger;
    clock?: { now(): number };
  }) {
    this.featureFlagProvider = opts.featureFlagProvider;
    this.auditWriter = opts.auditWriter;
    this.config = opts.config;
    this.logger = opts.logger;
    this.clock = opts.clock ?? { now: () => Date.now() };

    const meter = metrics.getMeter('@travel/illustrative');
    this.counter = meter.createCounter('illustrative_offers_served_total', {
      description:
        'Total number of illustrative (non-bookable) offers served to clients, ' +
        'by environment and category. A non-zero value in production triggers a CloudWatch alarm.',
    });
  }

  async searchOffers(
    criteria: SearchCriteria,
    correlationId: string,
  ): Promise<ReadonlyArray<Offer>> {
    const { environment, hardDisabledEnvironments } = this.config;

    // Layer 1: hard-disable (cannot be overridden by the flag)
    if (hardDisabledEnvironments.includes(environment)) {
      this.logger.info(
        {
          event: 'illustrative.suppressed.hard_disabled',
          correlationId,
          environment,
        },
        'Illustrative offers suppressed: environment is hard-disabled',
      );
      return [];
    }

    // Layer 2: feature flag (errors treated as disabled)
    let flagEnabled: boolean;
    try {
      flagEnabled = await this.featureFlagProvider.isEnabled(
        ILLUSTRATIVE_FLAG_KEY,
        environment,
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'illustrative.flag_provider_error',
          correlationId,
          environment,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'Feature flag provider error; treating illustrative flag as disabled',
      );
      return [];
    }

    if (!flagEnabled) {
      return [];
    }

    // Layer 3: generate offers (pure, no I/O — safe to do before audit write)
    const offers = this.generateOffers(criteria);

    // Layer 4: audit write (fail-closed)
    try {
      await this.auditWriter.write({
        type: 'ILLUSTRATIVE_OFFERS_SERVED',
        actor: this.config.actorIdentifier,
        timestamp: new Date(this.clock.now()),
        environment,
        category: criteria.kind,
        flagState: 'enabled',
        correlationId,
        offersCount: offers.length,
      });
    } catch (auditErr) {
      this.logger.error(
        {
          event: 'illustrative.audit_write_failed',
          correlationId,
          environment,
          category: criteria.kind,
          alertable: true,
          errorType:
            auditErr instanceof Error ? auditErr.constructor.name : 'unknown',
        },
        'Illustrative audit write failed; suppressing illustrative offers (fail-closed)',
      );
      return [];
    }

    // Layer 5: emit OTel counter
    this.counter.add(offers.length, {
      environment,
      category: criteria.kind,
    });

    this.logger.info(
      {
        event: 'illustrative.offers_served',
        correlationId,
        environment,
        category: criteria.kind,
        offersCount: offers.length,
      },
      'Illustrative offers served',
    );

    return offers;
  }

  /**
   * Generate deterministic illustrative offers from the search criteria.
   *
   * The SHA-256 fingerprint of the criteria is used as a stable seed so the
   * same query always produces the same offers.  The seed is used to derive
   * a price offset (up to ±20%) so different searches return visually distinct
   * but reproducible prices.
   */
  private generateOffers(criteria: SearchCriteria): ReadonlyArray<Offer> {
    const fingerprintBuf = buildSearchFingerprint(criteria);
    const fingerprintHex = fingerprintBuf.toString('hex');
    // Use the first byte (0–255) as a deterministic seed value
    const seed = fingerprintBuf[0] ?? 0;
    const priceMultiplier = 1 + (seed / 255) * 0.2; // 1.0 – 1.2 range

    const templates = TEMPLATES_BY_KIND[criteria.kind] ?? FLIGHT_TEMPLATES;
    const expiresAt = new Date(
      this.clock.now() + this.config.defaultValidityMinutes * 60_000,
    );

    return templates.map((tpl, index): Offer => {
      const price = Math.round(tpl.basePrice * priceMultiplier * 100) / 100;
      return {
        id: makeOfferId(criteria.kind, index, fingerprintHex),
        provenance: 'ILLUSTRATIVE',
        bookable: false,
        title: tpl.title,
        price,
        currency: (criteria.currency ?? 'USD').toUpperCase(),
        details: {
          ...tpl.details,
          supplier: 'ILLUSTRATIVE',
          notBookableLabel:
            'This is an illustrative result — real inventory was unavailable at the time of your search.',
        },
        expiresAt,
        freshness: 'FRESH',
      };
    });
  }
}
