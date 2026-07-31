import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';
import { OfferSchema } from '@travel/contracts';
import type { Offer } from '@travel/contracts';
import type { MinimalLogger, NormaliserConfig } from './types.js';

export class OfferNormaliser {
  private readonly config: NormaliserConfig;
  private readonly logger: MinimalLogger;
  private readonly clock: { now(): number };
  private readonly expiredCounter: Counter;

  constructor(opts: {
    config: NormaliserConfig;
    logger: MinimalLogger;
    clock?: { now(): number };
  }) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.clock = opts.clock ?? { now: () => Date.now() };

    const meter = metrics.getMeter('@travel/offer-normaliser');
    this.expiredCounter = meter.createCounter('offers_excluded_expired_total', {
      description:
        'Total number of offers excluded because their expiresAt was in the past at normalisation time, ' +
        'by category and supplier.',
    });
  }

  normalise(rawOffers: ReadonlyArray<unknown>): ReadonlyArray<Offer> {
    const nowMs = this.clock.now();
    const result: Offer[] = [];

    for (const raw of rawOffers) {
      const parsed = OfferSchema.safeParse(raw);
      if (!parsed.success) {
        const rawRecord =
          raw != null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const offerId =
          typeof rawRecord['id'] === 'string' ? rawRecord['id'] : '<unknown>';
        const supplier =
          typeof rawRecord['provenance'] === 'string'
            ? rawRecord['provenance']
            : '<unknown>';
        this.logger.warn(
          {
            event: 'offer.normalisation_failed',
            offerId,
            supplier,
            category: this.config.category,
            validationErrors: parsed.error.errors.map((e) => e.message),
          },
          'Offer failed Zod validation; dropping from result set',
        );
        continue;
      }

      const offer = parsed.data;

      if (offer.expiresAt.getTime() <= nowMs) {
        this.expiredCounter.add(1, {
          category: this.config.category,
          supplier: offer.provenance,
        });
        this.logger.warn(
          {
            event: 'offer.expired',
            offerId: offer.id,
            supplier: offer.provenance,
            category: this.config.category,
            expiresAt: offer.expiresAt.toISOString(),
          },
          'Offer is expired; excluding from result set',
        );
        continue;
      }

      result.push(offer);
    }

    return result;
  }
}
