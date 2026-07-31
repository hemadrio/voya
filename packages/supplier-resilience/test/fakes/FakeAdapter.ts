import type { NormalisedOffer, SupplierAdapter } from '../../src/types.js';

export type FakeAdapterMode = 'HEALTHY' | 'SLOW' | 'FAILING';

/**
 * Test double for SupplierAdapter.
 *
 *  HEALTHY — resolves immediately with the provided offers.
 *  SLOW    — returns a Promise that never resolves (simulates a straggler that
 *            must be cut off by the timeout race).
 *  FAILING — rejects immediately with a generic Error (no provider details).
 *
 * Call counts are tracked for assertions.
 */
export class FakeAdapter implements SupplierAdapter {
  readonly supplierName: string;
  private readonly _mode: FakeAdapterMode;
  private readonly _offers: ReadonlyArray<NormalisedOffer>;
  callCount = 0;

  constructor(
    supplierName: string,
    mode: FakeAdapterMode,
    offers: ReadonlyArray<NormalisedOffer> = [],
  ) {
    this.supplierName = supplierName;
    this._mode = mode;
    this._offers = offers;
  }

  searchOffers(_criteria: unknown, _correlationId: string): Promise<ReadonlyArray<NormalisedOffer>> {
    this.callCount++;

    switch (this._mode) {
      case 'HEALTHY':
        return Promise.resolve(this._offers);

      case 'SLOW':
        // Never resolves — the timeout race must cut it off
        return new Promise<ReadonlyArray<NormalisedOffer>>(() => { /* intentionally hangs */ });

      case 'FAILING':
        return Promise.reject(new Error('Supplier internal error'));
    }
  }
}
