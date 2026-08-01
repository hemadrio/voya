/**
 * Supplier commit fixtures for checkout saga tests (WO-048, AC12).
 *
 * Provides deterministic fixture data and in-memory fake adapter builders
 * for instant and reserve-then-confirm supplier flows.
 *
 * All IDs and references use SYNTH-* prefix — never real or production data.
 */

import type {
  CheckoutSupplierPort,
  SupplierFlowType,
  SupplierCommitResult,
  SupplierReserveToken,
} from "../../src/domain/CheckoutSupplierPort.js";
import { SupplierCommitError } from "../../src/domain/CheckoutSupplierPort.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export const SYNTH_FLIGHT_OFFER_ID = "offer-SYNTH-flight-001";
export const SYNTH_HOTEL_OFFER_ID  = "offer-SYNTH-hotel-001";
export const SYNTH_CAR_OFFER_ID    = "offer-SYNTH-car-001";

export const FIXTURE_FLIGHT_COMMIT_RESULT: SupplierCommitResult = {
  supplierReference: "PNR-SYNTH-F001",
};

export const FIXTURE_HOTEL_RESERVE_TOKEN: SupplierReserveToken = {
  supplierName: "RapidAPI-Hotels",
  providerRef: "HTL-HOLD-SYNTH-001",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

export const FIXTURE_HOTEL_COMMIT_RESULT: SupplierCommitResult = {
  supplierReference: "HTL-CONF-SYNTH-001",
};

export const FIXTURE_CAR_COMMIT_RESULT: SupplierCommitResult = {
  supplierReference: "CAR-SYNTH-001",
};

// ---------------------------------------------------------------------------
// Fake adapter builders
// ---------------------------------------------------------------------------

export interface AdapterCallLog {
  commit: string[];
  reserve: string[];
  confirm: string[];
  cancel: string[];
  cancelReserve: string[];
}

/**
 * Build an in-memory instant-flow adapter that succeeds.
 */
export function makeInstantAdapter(
  supplierName: string,
  result: SupplierCommitResult = FIXTURE_FLIGHT_COMMIT_RESULT,
): CheckoutSupplierPort & { calls: AdapterCallLog } {
  const calls: AdapterCallLog = { commit: [], reserve: [], confirm: [], cancel: [], cancelReserve: [] };
  return {
    supplierName,
    flowType: 'instant' as SupplierFlowType,
    calls,
    async commit(offerId, idempotencyRef) {
      calls.commit.push(idempotencyRef);
      return result;
    },
    async reserve() { throw new Error('reserve() not valid for instant flow'); },
    async confirm() { throw new Error('confirm() not valid for instant flow'); },
    async cancel(ref, idempotencyRef) {
      calls.cancel.push(idempotencyRef);
    },
    async cancelReserve(_token, idempotencyRef) {
      calls.cancelReserve.push(idempotencyRef);
    },
  };
}

/**
 * Build an in-memory reserve-then-confirm adapter that succeeds.
 */
export function makeRtcAdapter(
  supplierName: string,
  token: SupplierReserveToken = FIXTURE_HOTEL_RESERVE_TOKEN,
  result: SupplierCommitResult = FIXTURE_HOTEL_COMMIT_RESULT,
): CheckoutSupplierPort & { calls: AdapterCallLog } {
  const calls: AdapterCallLog = { commit: [], reserve: [], confirm: [], cancel: [], cancelReserve: [] };
  return {
    supplierName,
    flowType: 'reserveThenConfirm' as SupplierFlowType,
    calls,
    async commit() { throw new Error('commit() not valid for reserveThenConfirm flow'); },
    async reserve(_offerId, idempotencyRef) {
      calls.reserve.push(idempotencyRef);
      return token;
    },
    async confirm(_token, idempotencyRef) {
      calls.confirm.push(idempotencyRef);
      return result;
    },
    async cancel(ref, idempotencyRef) {
      calls.cancel.push(idempotencyRef);
    },
    async cancelReserve(_token, idempotencyRef) {
      calls.cancelReserve.push(idempotencyRef);
    },
  };
}

/**
 * Build an adapter that throws a rejection error on commit/reserve/confirm.
 */
export function makeFailingAdapter(
  supplierName: string,
  flowType: SupplierFlowType,
  failOn: 'commit' | 'reserve' | 'confirm',
  kind: 'rejected' | 'unavailable' | 'timeout' = 'rejected',
  message = 'Supplier rejected',
): CheckoutSupplierPort & { calls: AdapterCallLog } {
  const calls: AdapterCallLog = { commit: [], reserve: [], confirm: [], cancel: [], cancelReserve: [] };
  const error = new SupplierCommitError(supplierName, 'leg-0', message, kind);

  return {
    supplierName,
    flowType,
    calls,
    async commit(offerId, idempotencyRef) {
      calls.commit.push(idempotencyRef);
      if (failOn === 'commit') throw error;
      return FIXTURE_FLIGHT_COMMIT_RESULT;
    },
    async reserve(_offerId, idempotencyRef) {
      calls.reserve.push(idempotencyRef);
      if (failOn === 'reserve') throw error;
      return FIXTURE_HOTEL_RESERVE_TOKEN;
    },
    async confirm(_token, idempotencyRef) {
      calls.confirm.push(idempotencyRef);
      if (failOn === 'confirm') throw error;
      return FIXTURE_HOTEL_COMMIT_RESULT;
    },
    async cancel(ref, idempotencyRef) {
      calls.cancel.push(idempotencyRef);
    },
    async cancelReserve(_token, idempotencyRef) {
      calls.cancelReserve.push(idempotencyRef);
    },
  };
}
