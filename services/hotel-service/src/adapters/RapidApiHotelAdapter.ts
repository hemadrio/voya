/**
 * RapidApiHotelAdapter — SupplierPort implementation for RapidAPI hotel search.
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
 *   Exception: HTTP 429 (quota exhaustion) is remapped from
 *   SupplierRejectedRequestError to SupplierUnavailableError with a distinct
 *   log code (SUPPLIER_QUOTA_EXHAUSTED) so quota exhaustion is distinguishable
 *   from a provider outage in alerting dashboards.
 *
 * Observability:
 *   Each call is wrapped in OTel span "supplier.rapidapi-hotel.search" with
 *   attributes offersReturned, httpStatus, retried, and durationMs. The API
 *   key never appears in spans or log lines.
 *
 * Error classification (per WO-027):
 *   429                → SupplierUnavailableError (log code SUPPLIER_QUOTA_EXHAUSTED)
 *   other 4xx          → SupplierRejectedRequestError → 422 upstream
 *   5xx / network      → SupplierUnavailableError     → 502 upstream
 *   timeout            → SupplierTimeoutError         → 504 upstream
 */

import { trace, SpanStatusCode, context as otelContext } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import {
  SupplierRejectedRequestError,
  SupplierUnavailableError,
} from '@travel/supplier-port';
import type {
  SupplierPort,
  SupplierFlowShape,
  SearchCriteria,
  HotelSearchCriteria,
  SupplierHttpClient,
  Clock,
} from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import {
  mapRapidApiHotelOffers,
} from './mappers/rapidApiHotelMapper.js';
import type { RapidApiHotelSearchResponse } from './mappers/rapidApiHotelMapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RapidApiAdapterConfig {
  /** Full URL of the hotel search endpoint (without query string). */
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
// RapidApiHotelAdapter
// ---------------------------------------------------------------------------

const SUPPLIER_NAME = 'RAPIDAPI';
const tracer: Tracer = trace.getTracer('hotel-service');

export class RapidApiHotelAdapter implements SupplierPort {
  readonly supplierName = SUPPLIER_NAME;
  readonly supportedFlows: ReadonlyArray<SupplierFlowShape> = ['INSTANT'];

  private readonly httpClient: SupplierHttpClient;
  private readonly clock: Clock;
  private readonly config: RapidApiAdapterConfig;
  private readonly logger: MinimalLogger;

  constructor(opts: {
    httpClient: SupplierHttpClient;
    clock: Clock;
    config: RapidApiAdapterConfig;
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
    if (criteria.kind !== 'hotel') {
      return [];
    }

    const span = tracer.startSpan('supplier.rapidapi-hotel.search');
    const ctx = trace.setSpan(otelContext.active(), span);
    const startMs = this.clock.now();
    let httpStatus = 0;
    let retried = false;

    try {
      const result = await otelContext.with(ctx, () =>
        this.executeSearch(criteria as HotelSearchCriteria, correlationId, (status, didRetry) => {
          httpStatus = status;
          retried = didRetry;
        }),
      );

      span.setAttribute('offersReturned', result.length);
      span.setAttribute('httpStatus', httpStatus);
      span.setAttribute('retried', retried);
      span.setAttribute('durationMs', this.clock.now() - startMs);
      span.setStatus({ code: SpanStatusCode.OK });

      this.logger.info(
        {
          event: 'rapidapi.hotel.search.success',
          correlationId,
          offersReturned: result.length,
          retried,
          durationMs: this.clock.now() - startMs,
        },
        'RapidAPI hotel search completed',
      );

      return result;
    } catch (err) {
      span.setAttribute('offersReturned', 0);
      span.setAttribute('httpStatus', httpStatus);
      span.setAttribute('retried', retried);
      span.setAttribute('durationMs', this.clock.now() - startMs);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });

      this.logger.warn(
        {
          event: 'rapidapi.hotel.search.error',
          correlationId,
          retried,
          durationMs: this.clock.now() - startMs,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'RapidAPI hotel search failed',
      );

      throw err;
    } finally {
      span.end();
    }
  }

  private async executeSearch(
    criteria: HotelSearchCriteria,
    correlationId: string,
    recordMeta: (status: number, retried: boolean) => void,
  ): Promise<ReadonlyArray<Offer>> {
    const url = this.buildSearchUrl(criteria);

    let response: Awaited<ReturnType<SupplierHttpClient['request']>>;

    try {
      response = await this.httpClient.request(url, correlationId, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': this.config.apiKey,
          'x-rapidapi-host': this.config.apiHost,
        },
      });
      recordMeta(response.status, false);
    } catch (err) {
      // HTTP 429 (quota exhaustion) is remapped to SupplierUnavailableError with
      // a distinct log code so it is distinguishable from a provider outage in
      // alerting dashboards. Other 4xx errors propagate as SupplierRejectedRequestError.
      if (err instanceof SupplierRejectedRequestError && err.httpStatus === 429) {
        this.logger.warn(
          {
            event: 'rapidapi.hotel.quota_exceeded',
            correlationId,
            alertable: true,
            logCode: 'SUPPLIER_QUOTA_EXHAUSTED',
            supplier: SUPPLIER_NAME,
          },
          'RapidAPI hotel provider quota exhausted (HTTP 429)',
        );
        throw new SupplierUnavailableError(SUPPLIER_NAME, correlationId, 429);
      }
      throw err;
    }

    const body = await response.json<unknown>();
    return mapRapidApiHotelOffers(
      body as RapidApiHotelSearchResponse,
      criteria,
      this.config.defaultOfferValidityMinutes,
      new Date(this.clock.now()),
    );
  }

  private buildSearchUrl(criteria: HotelSearchCriteria): string {
    const params = new URLSearchParams();
    params.set('location', criteria.location);

    const checkIn =
      criteria.checkInDate instanceof Date
        ? criteria.checkInDate.toISOString().slice(0, 10)
        : String(criteria.checkInDate).slice(0, 10);
    const checkOut =
      criteria.checkOutDate instanceof Date
        ? criteria.checkOutDate.toISOString().slice(0, 10)
        : String(criteria.checkOutDate).slice(0, 10);

    params.set('checkIn', checkIn);
    params.set('checkOut', checkOut);
    params.set('adults', String(criteria.guests));
    params.set('currency', criteria.currency);

    if (criteria.starRating !== undefined) {
      params.set('starRating', String(criteria.starRating));
    }

    return `${this.config.searchEndpoint}?${params.toString()}`;
  }
}
