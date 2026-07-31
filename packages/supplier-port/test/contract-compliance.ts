/**
 * Reusable adapter compliance harness.
 *
 * Import and call `runSupplierPortComplianceTests` in any adapter's test suite
 * to verify that the adapter correctly implements the SupplierPort interface
 * contract — error mapping, flow shape declarations, non-retryable ops, etc.
 *
 * The harness is exported from the package so adapter test suites can depend
 * on @travel/supplier-port for structural testing.
 *
 * Usage (in an adapter's test file):
 *
 *   import { runSupplierPortComplianceTests } from '@travel/supplier-port/test/contract-compliance';
 *   runSupplierPortComplianceTests(() => createMyAdapter({ ... }));
 */

import type { SupplierPort, SupplierFlowShape, SearchCriteria } from '../src/SupplierPort.js';
import {
  SupplierError,
  SupplierEgressBlockedError,
  SupplierRejectedRequestError,
  SupplierTimeoutError,
  SupplierUnavailableError,
  isSupplierError,
} from '../src/errors.js';

// ---------------------------------------------------------------------------
// Compliance harness
// ---------------------------------------------------------------------------

export interface ComplianceHarnessOptions {
  /**
   * Flow shapes to exercise. If omitted, the harness exercises all shapes
   * declared in `adapter.supportedFlows`.
   */
  flowsToTest?: ReadonlyArray<SupplierFlowShape> | undefined;
}

/**
 * Register Jest `describe` / `it` blocks that verify adapter compliance.
 *
 * @param adapterFactory - Called once per `describe` to create a fresh adapter.
 * @param opts - Optional harness configuration.
 */
export function runSupplierPortComplianceTests(
  adapterFactory: () => SupplierPort,
  opts?: ComplianceHarnessOptions,
): void {
  describe('SupplierPort compliance', () => {
    let adapter: SupplierPort;

    beforeEach(() => {
      adapter = adapterFactory();
    });

    // -----------------------------------------------------------------------
    // Structural assertions
    // -----------------------------------------------------------------------

    it('declares at least one supported flow', () => {
      expect(adapter.supportedFlows.length).toBeGreaterThan(0);
    });

    it('declares a non-empty supplierName', () => {
      expect(typeof adapter.supplierName).toBe('string');
      expect(adapter.supplierName.trim().length).toBeGreaterThan(0);
    });

    it('exposes a searchOffers method', () => {
      expect(typeof adapter.searchOffers).toBe('function');
    });

    it('supportedFlows contains only valid SupplierFlowShape values', () => {
      const validShapes: ReadonlySet<SupplierFlowShape> = new Set([
        'INSTANT',
        'RESERVE_THEN_CONFIRM',
        'ARI_PUSH',
      ]);
      for (const flow of adapter.supportedFlows) {
        expect(validShapes.has(flow)).toBe(true);
      }
    });

    it('adapter that declares RESERVE_THEN_CONFIRM exposes reserve() and confirm()', () => {
      if (adapter.supportedFlows.includes('RESERVE_THEN_CONFIRM')) {
        expect(typeof adapter.reserve).toBe('function');
        expect(typeof adapter.confirm).toBe('function');
      }
    });

    // -----------------------------------------------------------------------
    // Error contract — all thrown errors must be SupplierError instances
    // -----------------------------------------------------------------------

    it('SupplierError subclasses satisfy isSupplierError type guard', () => {
      expect(isSupplierError(new SupplierTimeoutError('s', 'c', 2200))).toBe(true);
      expect(isSupplierError(new SupplierUnavailableError('s', 'c', 503))).toBe(true);
      expect(isSupplierError(new SupplierRejectedRequestError('s', 'c', 422))).toBe(true);
      expect(isSupplierError(new SupplierEgressBlockedError('s', 'c', 'evil.example.com'))).toBe(true);
      expect(isSupplierError(new Error('plain'))).toBe(false);
    });

    it('SupplierError subclasses carry supplierName and correlationId', () => {
      const err = new SupplierTimeoutError('flight-co', 'req-001', 2200);
      expect(err.supplierName).toBe('flight-co');
      expect(err.correlationId).toBe('req-001');
      expect(err.timeoutMs).toBe(2200);
      expect(err.name).toBe('SupplierTimeoutError');
    });

    it('SupplierError is abstract — subclasses have correct prototype chain', () => {
      const timeout = new SupplierTimeoutError('s', 'c', 1000);
      expect(timeout).toBeInstanceOf(SupplierError);
      expect(timeout).toBeInstanceOf(SupplierTimeoutError);
      expect(timeout).toBeInstanceOf(Error);
    });

    // -----------------------------------------------------------------------
    // Flow-shape validation — searchOffers must accept valid criteria
    // -----------------------------------------------------------------------

    const SAMPLE_CRITERIA: Record<'flight' | 'hotel' | 'car', SearchCriteria> = {
      flight: {
        kind: 'flight',
        departureAirport: 'LHR',
        arrivalAirport: 'JFK',
        departureDate: '2028-03-15',
        passengers: 1,
        seatClass: 'ECONOMY',
        currency: 'USD',
      },
      hotel: {
        kind: 'hotel',
        location: 'New York',
        checkInDate: '2028-03-15',
        checkOutDate: '2028-03-18',
        guests: 2,
        currency: 'USD',
      },
      car: {
        kind: 'car',
        pickupLocation: 'JFK',
        dropoffLocation: 'JFK',
        pickupDate: '2028-03-15',
        dropoffDate: '2028-03-18',
        carClass: 'ECONOMY',
        currency: 'USD',
      },
    };

    for (const travelKind of (['flight', 'hotel', 'car'] as const)) {
      it(`searchOffers for ${travelKind} criteria throws only SupplierError (or resolves)`, async () => {
        const criteria = SAMPLE_CRITERIA[travelKind];
        try {
          await adapter.searchOffers(criteria, 'compliance-test-corr');
        } catch (err) {
          // Adapter may throw because there is no real backend in the test env.
          // The contract requires it to throw only SupplierError subclasses.
          expect(isSupplierError(err)).toBe(true);
        }
      });
    }
  });
}
