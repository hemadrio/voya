/**
 * Refund test fixtures (WO-049 AC12).
 *
 * Committed Stripe refund response fixtures for:
 *   - succeeded refund
 *   - pending refund (charge not yet settled)
 *   - failed refund
 *   - duplicate-idempotent refund (same idempotency key → same result)
 *
 * Offer snapshots with refundable and non-refundable supplier terms.
 *
 * In-memory port doubles: MockStripePort, MockRefundPolicyPort, MockQueuePort,
 * MockSettlementWindowPort, MockRefundBookingQueryPort, MockRefundRepository.
 */

import type { StripeRefundResult } from "../../src/adapters/StripePort.js";
import type {
  RefundableBookingRow,
  EligibilityDecision,
  RefundPolicyPort,
  QueuePort,
  QueueMessage,
  QueuePublishOptions,
  SettlementWindowPort,
  RefundBookingQueryPort,
} from "../../src/domain/RefundService.js";
import type { PaymentRow, PaymentRepositoryPort, CreatePaymentData } from "../../src/repositories/PaymentRepository.js";
import type { AuditTxClient } from "../../src/domain/AuditWriter.js";
import type { StripePort, StripeCreateIntentParams, StripeCreateRefundParams, StripeIntentResult } from "../../src/adapters/StripePort.js";

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export const FIXTURE_CHARGE_ID = "pay-charge-001";
export const FIXTURE_CHARGE_PROVIDER_REF = "pi_3MockCharge001";
export const FIXTURE_BOOKING_ID = "booking-refund-test-001";
export const FIXTURE_USER_ID = "user-refund-test-001";
export const FIXTURE_CURRENCY = "USD";
export const FIXTURE_CHARGE_AMOUNT = BigInt(10000); // $100.00 in cents

// ---------------------------------------------------------------------------
// Stripe refund response fixtures
// ---------------------------------------------------------------------------

/** Stripe refund succeeded immediately. */
export const STRIPE_REFUND_SUCCEEDED: StripeRefundResult = {
  id: "re_3MockSucceeded001",
  status: "succeeded",
  amountMinor: BigInt(5000),
  currency: "usd",
};

/** Stripe refund pending (charge not yet settled). */
export const STRIPE_REFUND_PENDING: StripeRefundResult = {
  id: "re_3MockPending001",
  status: "pending",
  amountMinor: BigInt(5000),
  currency: "usd",
};

/** Stripe refund failed (e.g. bank declined). */
export const STRIPE_REFUND_FAILED: StripeRefundResult = {
  id: "re_3MockFailed001",
  status: "failed",
  amountMinor: BigInt(5000),
  currency: "usd",
};

/** Duplicate-idempotent: same Stripe refund returned for the same idempotency key. */
export const STRIPE_REFUND_DUPLICATE_IDEMPOTENT: StripeRefundResult = {
  id: "re_3MockDuplicate001",
  status: "succeeded",
  amountMinor: BigInt(5000),
  currency: "usd",
};

// ---------------------------------------------------------------------------
// Offer snapshot fixtures
// ---------------------------------------------------------------------------

/** Fully refundable booking — no penalty. */
export const OFFER_SNAPSHOT_REFUNDABLE = {
  supplierTerms: {
    refundable: true,
    penaltyMinor: 0,
    penaltyCurrency: "USD",
    windowDays: 30,
    termRef: "fully_refundable",
  },
};

/** Non-refundable booking. */
export const OFFER_SNAPSHOT_NON_REFUNDABLE = {
  supplierTerms: {
    refundable: false,
    termRef: "non_refundable_fare",
  },
};

/** Multi-leg with one refundable leg and one non-refundable leg. */
export const OFFER_SNAPSHOT_MIXED_LEGS = {
  legs: [
    {
      legId: "leg-outbound",
      supplierTerms: {
        refundable: true,
        penaltyMinor: 0,
        termRef: "flex_outbound",
      },
    },
    {
      legId: "leg-return",
      supplierTerms: {
        refundable: false,
        termRef: "non_refundable_return",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Charge payment row fixture
// ---------------------------------------------------------------------------

export const FIXTURE_CHARGE_ROW: PaymentRow = {
  id: FIXTURE_CHARGE_ID,
  bookingId: FIXTURE_BOOKING_ID,
  provider: "stripe",
  providerReference: FIXTURE_CHARGE_PROVIDER_REF,
  type: "CHARGE",
  parentPaymentId: null,
  amountMinor: FIXTURE_CHARGE_AMOUNT,
  currency: FIXTURE_CURRENCY,
  status: "SUCCEEDED",
  cardBrand: "visa",
  cardLast4: "4242",
  createdAt: new Date("2026-07-15T10:00:00.000Z"),
  updatedAt: new Date("2026-07-15T10:00:00.000Z"),
};

// ---------------------------------------------------------------------------
// Mock port implementations
// ---------------------------------------------------------------------------

/** In-memory Stripe port for unit tests. */
export function makeMockStripePort(
  refundResult: StripeRefundResult = STRIPE_REFUND_SUCCEEDED,
  opts: { throwOnRefund?: Error | null } = {},
): StripePort {
  return {
    async createIntent(_params: StripeCreateIntentParams): Promise<StripeIntentResult> {
      throw new Error("Not implemented in refund tests");
    },
    async createRefund(_params: StripeCreateRefundParams): Promise<StripeRefundResult> {
      if (opts.throwOnRefund) throw opts.throwOnRefund;
      return { ...refundResult, amountMinor: _params.amountMinor };
    },
  };
}

/** Capturing queue mock for asserting exactly-once publish. */
export function makeMockQueue(): QueuePort & { published: Array<{ message: QueueMessage; opts: QueuePublishOptions }> } {
  const published: Array<{ message: QueueMessage; opts: QueuePublishOptions }> = [];
  return {
    published,
    async publish(message: QueueMessage, opts: QueuePublishOptions): Promise<void> {
      published.push({ message, opts });
    },
  };
}

/** Simple settlement window mock. */
export function makeMockSettlementWindow(
  wording = "Refunds typically process in 5–10 business days.",
): SettlementWindowPort {
  return {
    async lookup(_provider: string, _currency: string): Promise<string> {
      return wording;
    },
  };
}

/** In-memory refund policy port. */
export function makeMockRefundPolicy(decision: EligibilityDecision): RefundPolicyPort {
  return {
    async checkEligibility(
      _snapshot: unknown,
      _chargeAmount: bigint,
      _currency: string,
      _legId?: string,
    ): Promise<EligibilityDecision> {
      return decision;
    },
  };
}

export function makeEligibleDecision(chargeAmountMinor: bigint = FIXTURE_CHARGE_AMOUNT): EligibilityDecision {
  return {
    eligible: true,
    refundableAmountMinor: chargeAmountMinor,
    currency: FIXTURE_CURRENCY,
  };
}

export function makeNonRefundableDecision(termRef = "non_refundable_fare"): EligibilityDecision {
  return {
    eligible: false,
    refundableAmountMinor: BigInt(0),
    currency: FIXTURE_CURRENCY,
    supplierTermRef: termRef,
  };
}

/** In-memory booking query port. */
export function makeMockBookingQuery(
  booking: RefundableBookingRow | null = null,
): RefundBookingQueryPort {
  const defaultBooking: RefundableBookingRow = {
    id: FIXTURE_BOOKING_ID,
    status: "CONFIRMED",
    userId: FIXTURE_USER_ID,
    offerSnapshot: OFFER_SNAPSHOT_REFUNDABLE,
  };
  return {
    async findBookingForRefund(_bookingId: string): Promise<RefundableBookingRow | null> {
      return booking ?? defaultBooking;
    },
  };
}

/** In-memory payment repository for unit tests. */
export function makeMockRefundRepository(opts: {
  chargeRow?: PaymentRow | null;
  existingRefunds?: PaymentRow[];
  lockAcquired?: boolean;
  throwOnCreate?: boolean;
} = {}): PaymentRepositoryPort & {
  created: CreatePaymentData[];
  auditRows: Record<string, unknown>[];
} {
  const {
    chargeRow = FIXTURE_CHARGE_ROW,
    existingRefunds = [],
    lockAcquired = true,
    throwOnCreate = false,
  } = opts;

  const created: CreatePaymentData[] = [];
  const auditRows: Record<string, unknown>[] = [];

  // Build a shared transaction mock
  const mockTx: AuditTxClient & {
    payment: { findMany(args: { where: { parentPaymentId: string; type: string }; select?: { amountMinor: boolean } }): Promise<Array<{ amountMinor: bigint }>> };
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  } = {
    bookingAuditLog: {
      async create(args: { data: Record<string, unknown> }) {
        auditRows.push(args.data);
        return {};
      },
    },
    payment: {
      async findMany(_args): Promise<Array<{ amountMinor: bigint }>> {
        return existingRefunds.map((r) => ({ amountMinor: r.amountMinor }));
      },
    },
    async $queryRawUnsafe<T>(_query: string, ..._values: unknown[]): Promise<T> {
      if (!lockAcquired) return [] as T;
      return (chargeRow ? [chargeRow] : []) as T;
    },
  };

  return {
    created,
    auditRows,

    async findExistingCharge(_bookingId, _amountMinor, _currency) {
      return chargeRow;
    },

    async findChargeForBooking(_bookingId) {
      return chargeRow;
    },

    async findByProviderRef(_provider, _providerReference) {
      return existingRefunds.find((r) => r.providerReference === _providerReference) ?? null;
    },

    async findAndLockCharge(_chargeId, _tx) {
      if (!lockAcquired) return null;
      return chargeRow;
    },

    async sumRefundedAmount(_parentPaymentId, _tx) {
      return existingRefunds.reduce((sum, r) => sum + r.amountMinor, BigInt(0));
    },

    async createPaymentInTx(data, _tx) {
      if (throwOnCreate) throw new Error("DB write error");
      created.push(data);
      const row: PaymentRow = {
        id: `pay-refund-${created.length}`,
        bookingId: data.bookingId,
        provider: data.provider,
        providerReference: data.providerReference,
        type: data.type,
        parentPaymentId: data.parentPaymentId ?? null,
        amountMinor: data.amountMinor,
        currency: data.currency,
        status: data.status,
        cardBrand: null,
        cardLast4: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return row;
    },

    async runInTransaction<T>(work: (tx: AuditTxClient) => Promise<T>): Promise<T> {
      return work(mockTx);
    },
  };
}
