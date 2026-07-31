/**
 * RapidApiCarAdapter — SupplierPort implementation for RapidAPI car rental search.
 *
 * Booking protocol: INSTANT (search → book, no hold step).
 *
 * Auth: x-rapidapi-key and x-rapidapi-host request headers, sourced from
 * injected config backed by AWS Secrets Manager. The API key is never logged
 * or included in span attributes.
 *
 * HTTP:
 *   Uses SupplierHttpClient for all search calls — 2200 ms timeout, single
 *   retry on 5xx or network error, no retry on 4xx.
 *
 * Vehicle class mapping:
 *   Provider free-form descriptions are mapped to canonical CarClass values
 *   by a data-driven token table (vehicleClassMap.ts). Unmappable descriptions
 *   yield UNKNOWN plus a warn-level log so the table can be extended without
 *   code changes. UNKNOWN is never a silent default.
 *
 * Observability:
 *   Each call is wrapped in OTel span "supplier.rapidapi-car.search" with
 *   attributes offersReturned, unmappedClassCount, httpStatus, retried, and
 *   durationMs. The API key never appears in spans or log lines.
 *
 * Error classification (per WO-028):
 *   4xx (including 429) → SupplierRejectedRequestError → 422 upstream
 *   5xx / network       → SupplierUnavailableError     → 502 upstream
 *   timeout             → SupplierTimeoutError         → 504 upstream
 */

import { trace, SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import type {
  SupplierPort,
  SupplierFlowShape,
  SearchCriteria,
  CarSearchCriteria,
  SupplierHttpClient,
  Clock,
} from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import { mapRapidApiCarOffers } from './mappers/rapidApiCarMapper.js';
import type { RapidApiCarSearchResponse } from './mappers/rapidApiCarMapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RapidApiCarAdapterConfig {
  /** Full URL of the car rental search endpoint (without query string). */
  readonly searchEndpoint: string;
  /**
   * RapidAPI provider hostname — injected from config backed by Secrets Manager.
   * Sent as the x-rapidapi-host header. Never logged.
   */
  readonly apiHost: string;
  /**
   * RapidAPI API key — injected from config backed by Secrets Manager.
   * Sent as the x-rapidapi-key header. Never logged.
   */
  readonly apiKey: string;
  /**
   * Default offer validity window in minutes when the provider omits an expiry.
   * Typical value: 30 (30 minutes).
   */
  readonly defaultOfferValidityMinutes: number;
}

// ---------------------------------------------------------------------------
// RapidApiCarAdapter
// ---------------------------------------------------------------------------

const SUPPLIER_NAME = 'RAPIDAPI';
const tracer: Tracer = trace.getTracer('car-service');

export class RapidApiCarAdapter implements SupplierPort {
  readonly supplierName = SUPPLIER_NAME;
  readonly supportedFlows: ReadonlyArray<SupplierFlowShape> = ['INSTANT'];

  private readonly httpClient: SupplierHttpClient;
  private readonly clock: Clock;
  private readonly config: RapidApiCarAdapterConfig;
  private readonly logger: MinimalLogger;

  constructor(opts: {
    httpClient: SupplierHttpClient;
    clock: Clock;
    config: RapidApiCarAdapterConfig;
    logger: MinimalLogger;
  }) {
    this.httpClient = opts.httpClient;
    this.clock = opts.clock;
    this.config = opts.config;
    this.logger = opts.logger;
  }

  async searchOffers(
    criteria: SearchCriteria,
    correlationId: string,
  ): Promise<ReadonlyArray<Offer>> {
    if (criteria.kind !== 'car') {
      return [];
    }

    const span = tracer.startSpan('supplier.rapidapi-car.search');
    const ctx = trace.setSpan(otelContext.active(), span);
    const startMs = this.clock.now();
    let httpStatus = 0;
    let retried = false;
    let unmappedClassCount = 0;

    try {
      const result = await otelContext.with(ctx, () =>
        this.executeSearch(criteria as CarSearchCriteria, correlationId, (status, didRetry) => {
          httpStatus = status;
          retried = didRetry;
        }),
      );

      unmappedClassCount = result.unmappedDescriptions.length;

      // Warn for each unmapped vehicle class so the mapping table can be extended.
      for (const desc of result.unmappedDescriptions) {
        this.logger.warn(
          {
            event: 'rapidapi.car.unmapped_vehicle_class',
            correlationId,
            rawDescription: desc,
            supplier: SUPPLIER_NAME,
          },
          'Vehicle class could not be mapped to canonical class; add token to vehicleClassMap',
        );
      }

      span.setAttribute('offersReturned', result.offers.length);
      span.setAttribute('unmappedClassCount', unmappedClassCount);
      span.setAttribute('httpStatus', httpStatus);
      span.setAttribute('retried', retried);
      span.setAttribute('durationMs', this.clock.now() - startMs);
      span.setStatus({ code: SpanStatusCode.OK });

      this.logger.info(
        {
          event: 'rapidapi.car.search.success',
          correlationId,
          offersReturned: result.offers.length,
          unmappedClassCount,
          retried,
          durationMs: this.clock.now() - startMs,
        },
        'RapidAPI car rental search completed',
      );

      return result.offers;
    } catch (err) {
      span.setAttribute('offersReturned', 0);
      span.setAttribute('unmappedClassCount', unmappedClassCount);
      span.setAttribute('httpStatus', httpStatus);
      span.setAttribute('retried', retried);
      span.setAttribute('durationMs', this.clock.now() - startMs);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });

      this.logger.warn(
        {
          event: 'rapidapi.car.search.error',
          correlationId,
          retried,
          durationMs: this.clock.now() - startMs,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'RapidAPI car rental search failed',
      );

      throw err;
    } finally {
      span.end();
    }
  }

  private async executeSearch(
    criteria: CarSearchCriteria,
    correlationId: string,
    recordMeta: (status: number, retried: boolean) => void,
  ): Promise<ReturnType<typeof mapRapidApiCarOffers>> {
    const url = this.buildSearchUrl(criteria);

    const response = await this.httpClient.request(url, correlationId, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': this.config.apiKey,
        'x-rapidapi-host': this.config.apiHost,
      },
    });
    recordMeta(response.status, false);

    const body = await response.json<unknown>();
    return mapRapidApiCarOffers(
      body as RapidApiCarSearchResponse,
      criteria,
      this.config.defaultOfferValidityMinutes,
      new Date(this.clock.now()),
    );
  }

  private buildSearchUrl(criteria: CarSearchCriteria): string {
    const params = new URLSearchParams();
    params.set('pickupLocation', criteria.pickupLocation);
    params.set('dropoffLocation', criteria.dropoffLocation);

    const pickupDate =
      criteria.pickupDate instanceof Date
        ? criteria.pickupDate.toISOString().slice(0, 10)
        : String(criteria.pickupDate).slice(0, 10);
    const dropoffDate =
      criteria.dropoffDate instanceof Date
        ? criteria.dropoffDate.toISOString().slice(0, 10)
        : String(criteria.dropoffDate).slice(0, 10);

    params.set('pickupDate', pickupDate);
    params.set('dropoffDate', dropoffDate);
    params.set('carClass', criteria.carClass);
    params.set('currency', criteria.currency);

    return `${this.config.searchEndpoint}?${params.toString()}`;
  }
}
