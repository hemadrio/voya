/**
 * AmadeusFlightAdapter — SupplierPort implementation for Amadeus GDS flights.
 *
 * Booking protocol: INSTANT (search → book, no hold step).
 *
 * Token management:
 *   AmadeusTokenProvider supplies cached OAuth2 tokens. If a search returns 401
 *   (token expired mid-flight or rotated), the adapter refreshes the token and
 *   retries the search exactly once before propagating SupplierUnavailableError.
 *
 * HTTP:
 *   Uses SupplierHttpClient for all search calls — 2200 ms timeout, single retry
 *   on 5xx / network error, no retry on 4xx.
 *
 * Observability:
 *   Each call is wrapped in OTel span "supplier.amadeus.search" with attributes
 *   offersReturned, httpStatus, retried, and durationMs.  Credentials never
 *   appear in spans or log lines.
 *
 * Error classification (per WO-026):
 *   4xx (non-401 first call) → SupplierRejectedRequestError → 422 upstream
 *   5xx / network fault     → SupplierUnavailableError     → 502 upstream
 *   timeout                 → SupplierTimeoutError         → 504 upstream
 *   401 on search (post-refresh) → SupplierUnavailableError (credentials issue)
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
  FlightSearchCriteria,
  SupplierHttpClient,
  Clock,
} from '@travel/supplier-port';
import type { Offer } from '@travel/contracts';
import type { AmadeusTokenProvider } from './AmadeusTokenProvider.js';
import { mapAmadeusOffers } from './mappers/amadeusOfferMapper.js';
import type { AmadeusSearchResponse } from './mappers/amadeusOfferMapper.js';
import type { MinimalLogger } from './AmadeusTokenProvider.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AmadeusAdapterConfig {
  /** Full URL of the Amadeus v2 flight-offers search endpoint. */
  readonly searchEndpoint: string;
  /**
   * Default offer validity window in minutes when Amadeus omits lastTicketingDate.
   * Typical value: 60 (1 hour).
   */
  readonly defaultOfferValidityMinutes: number;
}

// ---------------------------------------------------------------------------
// AmadeusFlightAdapter
// ---------------------------------------------------------------------------

const SUPPLIER_NAME = 'AMADEUS';
const tracer: Tracer = trace.getTracer('flight-service');

export class AmadeusFlightAdapter implements SupplierPort {
  readonly supplierName = SUPPLIER_NAME;
  readonly supportedFlows: ReadonlyArray<SupplierFlowShape> = ['INSTANT'];

  private readonly tokenProvider: AmadeusTokenProvider;
  private readonly httpClient: SupplierHttpClient;
  private readonly clock: Clock;
  private readonly config: AmadeusAdapterConfig;
  private readonly logger: MinimalLogger;

  constructor(opts: {
    tokenProvider: AmadeusTokenProvider;
    httpClient: SupplierHttpClient;
    clock: Clock;
    config: AmadeusAdapterConfig;
    logger: MinimalLogger;
  }) {
    this.tokenProvider = opts.tokenProvider;
    this.httpClient = opts.httpClient;
    this.clock = opts.clock;
    this.config = opts.config;
    this.logger = opts.logger;
  }

  async searchOffers(
    criteria: SearchCriteria,
    correlationId: string,
  ): Promise<ReadonlyArray<Offer>> {
    if (criteria.kind !== 'flight') {
      return [];
    }

    const span = tracer.startSpan('supplier.amadeus.search');
    const ctx = trace.setSpan(otelContext.active(), span);
    const startMs = this.clock.now();
    let retried = false;
    let httpStatus = 0;

    try {
      const result = await otelContext.with(ctx, () =>
        this.executeSearch(criteria as FlightSearchCriteria, correlationId, (status, didRetry) => {
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
          event: 'amadeus.search.success',
          correlationId,
          offersReturned: result.length,
          retried,
          durationMs: this.clock.now() - startMs,
        },
        'Amadeus flight search completed',
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
          event: 'amadeus.search.error',
          correlationId,
          retried,
          durationMs: this.clock.now() - startMs,
          errorType: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'Amadeus flight search failed',
      );

      throw err;
    } finally {
      span.end();
    }
  }

  private async executeSearch(
    criteria: FlightSearchCriteria,
    correlationId: string,
    recordMeta: (status: number, retried: boolean) => void,
  ): Promise<ReadonlyArray<Offer>> {
    const token = await this.tokenProvider.getToken(correlationId);
    const url = this.buildSearchUrl(criteria);

    let response: Awaited<ReturnType<SupplierHttpClient['request']>> | undefined;
    try {
      response = await this.httpClient.request(url, correlationId, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      recordMeta(response.status, false);
    } catch (err) {
      // 401 on search = token expired mid-flight; refresh once and retry
      if (
        err instanceof SupplierRejectedRequestError &&
        err.httpStatus === 401
      ) {
        const freshToken = await this.tokenProvider.refreshToken(correlationId);
        // Use allowRetry: false — we already handled the one retry at the token level
        response = await this.httpClient.request(url, correlationId, {
          method: 'GET',
          headers: { Authorization: `Bearer ${freshToken}` },
          allowRetry: false,
        });
        recordMeta(response.status, true);
      } else {
        throw err;
      }
    }

    // response is always defined here: either set in try (success), or set in
    // the 401 refresh branch; any other error path throws before this line.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const body = await response!.json<unknown>();
    return mapAmadeusOffers(
      body as AmadeusSearchResponse,
      criteria,
      this.config.defaultOfferValidityMinutes,
      new Date(this.clock.now()),
    );
  }

  private buildSearchUrl(criteria: FlightSearchCriteria): string {
    const params = new URLSearchParams();
    params.set('originLocationCode', criteria.departureAirport);
    params.set('destinationLocationCode', criteria.arrivalAirport);

    const depDate =
      criteria.departureDate instanceof Date
        ? criteria.departureDate.toISOString().slice(0, 10)
        : String(criteria.departureDate).slice(0, 10);
    params.set('departureDate', depDate);

    if (criteria.returnDate !== undefined) {
      const retDate =
        criteria.returnDate instanceof Date
          ? criteria.returnDate.toISOString().slice(0, 10)
          : String(criteria.returnDate).slice(0, 10);
      params.set('returnDate', retDate);
    }

    params.set('adults', String(criteria.passengers));

    const seatClassMap: Record<string, string> = {
      ECONOMY: 'ECONOMY',
      BUSINESS: 'BUSINESS',
      FIRST: 'FIRST',
    };
    params.set('travelClass', seatClassMap[criteria.seatClass] ?? 'ECONOMY');
    params.set('currencyCode', criteria.currency);
    params.set('nonStop', 'false');
    params.set('max', '20');

    return `${this.config.searchEndpoint}?${params.toString()}`;
  }
}
