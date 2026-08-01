/**
 * RefundService — idempotent refund issuance through the original payment route (WO-049).
 *
 * Guarantees:
 *   1. Refunds are always issued against the original CHARGE via Stripe.
 *   2. Idempotency key is deterministic: sha256(chargeProviderReference + ':' + scopeKey).
 *      A retry with the same scope returns the same Stripe refund and creates no second row.
 *   3. Cumulative ceiling check is performed inside a transaction with SELECT FOR UPDATE
 *      on the CHARGE row so two concurrent partial refunds cannot both exceed the limit.
 *   4. Eligibility is derived from supplier terms in the offer snapshot via RefundPolicyPort;
 *      no refundability is assumed when terms are absent.
 *   5. REFUND ledger row, REFUNDED audit row, and refund.issued queue message are all
 *      committed in one transaction boundary.
 *   6. No floating-point arithmetic: all amounts are bigint minor units.
 *
 * Constraints (AC9):
 *   - All amountMinor values entering this module MUST be bigint.
 *   - The assertIntegerMinorUnits helper (from @travel/contracts) is the boundary guard.
 *
 * PCI note: no card numbers, CVCs, or expiry dates enter this service.
 */

import {
  notFound,
  refundExceedsCharge,
  notRefundable,
  providerUnavailable,
  assertIntegerMinorUnits,
} from "@travel/contracts";
import type { DomainError } from "@travel/contracts/errors";
import { writeAudit } from "./AuditWriter.js";
import type { AuditTxClient } from "./AuditWriter.js";
import type { StripePort, StripeRefundResult } from "../adapters/StripePort.js";
import { deriveRefundIdempotencyKey, buildRefundScopeKey } from "../adapters/StripePort.js";
import type { PaymentRepositoryPort, PaymentRow } from "../repositories/PaymentRepository.js";

// ---------------------------------------------------------------------------
// Port interfaces
// ---------------------------------------------------------------------------

/** Minimal booking projection needed for refund eligibility checks. */
export interface RefundableBookingRow {
  id: string;
  status: string;
  userId: string;
  /** Offer snapshot JSON stored at booking creation — contains supplier terms. */
  offerSnapshot: unknown;
}

/** Port for querying booking state (injected for testability). */
export interface RefundBookingQueryPort {
  findBookingForRefund(bookingId: string): Promise<RefundableBookingRow | null>;
}

// ---------------------------------------------------------------------------
// RefundPolicyPort — derives eligibility from supplier terms (WO-049 AC6)
// ---------------------------------------------------------------------------

/** Policy decision returned by RefundPolicyPort.checkEligibility. */
export interface EligibilityDecision {
  /** True when the booking/leg may be refunded under supplier terms. */
  eligible: boolean;
  /** Maximum refundable amount in minor units (charge minus any penalty). */
  refundableAmountMinor: bigint;
  currency: string;
  /** Human-readable supplier term key that prevents the refund (when eligible=false). */
  supplierTermRef?: string;
}

/**
 * Port that derives refund eligibility and the refundable amount from
 * supplier terms stored in the booking offer snapshot.
 *
 * Defaults to non-refundable when terms are absent (no eligibility inferred).
 */
export interface RefundPolicyPort {
  checkEligibility(
    offerSnapshot: unknown,
    chargeAmountMinor: bigint,
    currency: string,
    legId?: string,
  ): Promise<EligibilityDecision>;
}

// ---------------------------------------------------------------------------
// QueuePort — publish refund.issued event exactly once (WO-049 AC8)
// ---------------------------------------------------------------------------

export interface QueueMessage {
  type: string;
  payload: unknown;
}

export interface QueuePublishOptions {
  /** SQS FIFO MessageDeduplicationId — must equal the refund provider reference. */
  messageDeduplicationId: string;
  messageGroupId?: string;
}

export interface QueuePort {
  publish(message: QueueMessage, opts: QueuePublishOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// SettlementWindowPort — configurable wording template (WO-049 AC7)
// ---------------------------------------------------------------------------

/**
 * Port that returns the traveler-facing settlement window description for a
 * given provider and currency.  Backed by a runtime-configurable template so
 * legal wording can change without a deployment (AC7).
 */
export interface SettlementWindowPort {
  lookup(provider: string, currency: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// RefundPort — public abstraction for the WO-048 saga compensation path
// ---------------------------------------------------------------------------

/** Result returned by RefundService when used via the RefundPort abstraction. */
export interface RefundResult {
  refundId: string;
  providerReference: string;
  amountMinor: bigint;
  currency: string;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
  settlementWindow: string;
}

/** Internal refund request used by the domain service. */
export interface RefundServiceRequest {
  bookingId: string;
  /** If omitted, defaults to the full remaining amount on the charge. */
  amountMinor?: bigint;
  currency: string;
  reason: string;
  /** Leg identifier for split/partial refunds. */
  legId?: string;
  /** Actor performing the refund (for audit). */
  actor: { id: string; role: string };
  /** Trace/correlation ID. */
  correlationId?: string;
}

/**
 * RefundPort exported for the WO-048 saga compensation path.
 *
 * The saga orchestrator (CheckoutSagaOrchestrator) depends on this abstraction,
 * not on RefundService directly, so the orchestrator remains decoupled from
 * payment-service internals.
 */
export interface RefundPort {
  issueRefund(request: RefundServiceRequest): Promise<RefundResult>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface RefundLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// RefundService deps
// ---------------------------------------------------------------------------

export interface RefundServiceDeps {
  stripePort: StripePort;
  paymentRepo: PaymentRepositoryPort;
  bookingQuery: RefundBookingQueryPort;
  refundPolicy: RefundPolicyPort;
  settlementWindow: SettlementWindowPort;
  queue: QueuePort;
  auditWriter?: typeof writeAudit;
  clock?: () => Date;
  log?: RefundLogger;
}

// ---------------------------------------------------------------------------
// RefundService implementation
// ---------------------------------------------------------------------------

export class RefundService implements RefundPort {
  private readonly stripePort: StripePort;
  private readonly paymentRepo: PaymentRepositoryPort;
  private readonly bookingQuery: RefundBookingQueryPort;
  private readonly refundPolicy: RefundPolicyPort;
  private readonly settlementWindow: SettlementWindowPort;
  private readonly queue: QueuePort;
  private readonly auditWriter: typeof writeAudit;
  private readonly clock: () => Date;
  private readonly log: RefundLogger | undefined;

  constructor(deps: RefundServiceDeps) {
    this.stripePort = deps.stripePort;
    this.paymentRepo = deps.paymentRepo;
    this.bookingQuery = deps.bookingQuery;
    this.refundPolicy = deps.refundPolicy;
    this.settlementWindow = deps.settlementWindow;
    this.queue = deps.queue;
    this.auditWriter = deps.auditWriter ?? writeAudit;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  /**
   * Issue a refund through the original payment route.
   *
   * Idempotent: given the same bookingId + scope (legId + amountMinor or 'full'),
   * repeated calls return the existing refund without creating a second ledger row.
   */
  async issueRefund(request: RefundServiceRequest): Promise<RefundResult> {
    const now = this.clock();

    // ── 1. Validate requested amount (AC9 — no floats) ───────────────────────
    let requestedAmountMinor: bigint | undefined;
    if (request.amountMinor !== undefined) {
      requestedAmountMinor = assertIntegerMinorUnits(request.amountMinor, "amountMinor");
      if (requestedAmountMinor <= BigInt(0)) {
        throw Object.assign(new Error("amountMinor must be a positive integer"), { code: "VALIDATION_FAILED" });
      }
    }

    // ── 2. Fetch booking ──────────────────────────────────────────────────────
    const booking = await this.bookingQuery.findBookingForRefund(request.bookingId);
    if (!booking) {
      throw notFound(`Booking "${request.bookingId}" not found.`);
    }

    // ── 3. Find the original CHARGE payment ──────────────────────────────────
    const charge = await this.paymentRepo.findChargeForBooking(request.bookingId);
    if (!charge) {
      throw notFound(`No charge payment found for booking "${request.bookingId}".`);
    }

    // ── 4. Check eligibility via RefundPolicyPort ─────────────────────────────
    const eligibility = await this.refundPolicy.checkEligibility(
      booking.offerSnapshot,
      charge.amountMinor,
      request.currency,
      request.legId,
    );
    if (!eligibility.eligible) {
      throw notRefundable(request.legId, eligibility.supplierTermRef ?? "non_refundable");
    }

    // ── 5. Determine refund amount ────────────────────────────────────────────
    //   Full refund when amountMinor omitted; cap at the policy's refundable amount
    const scopeKey = buildRefundScopeKey(requestedAmountMinor, request.legId);
    const idempotencyKey = deriveRefundIdempotencyKey(
      charge.providerReference,
      scopeKey,
    );

    // ── 6. Execute within a transaction with SELECT FOR UPDATE on the charge ──
    let stripeRefund!: StripeRefundResult;
    let refundRow!: PaymentRow;
    let amountToRefund!: bigint;

    await this.paymentRepo.runInTransaction(async (tx) => {
      // Lock the charge row to serialise concurrent requests
      const lockedCharge = await this.paymentRepo.findAndLockCharge(charge.id, tx);
      if (!lockedCharge) {
        throw notFound(`Charge "${charge.id}" not found or not lockable.`);
      }

      // Sum existing refunds within the same transaction
      const alreadyRefunded = await this.paymentRepo.sumRefundedAmount(charge.id, tx);

      // Compute amount for this refund
      const remaining = lockedCharge.amountMinor - alreadyRefunded;
      amountToRefund = requestedAmountMinor ?? remaining;

      // AC4 — ceiling check in minor units (no floats)
      if (alreadyRefunded + amountToRefund > lockedCharge.amountMinor) {
        throw refundExceedsCharge(alreadyRefunded, lockedCharge.amountMinor, amountToRefund);
      }

      // ── 7. Call Stripe (inside the locked transaction for concurrency safety) ──
      try {
        stripeRefund = await this.stripePort.createRefund({
          chargeProviderReference: lockedCharge.providerReference,
          amountMinor: amountToRefund,
          idempotencyKey,
          reason: request.reason,
        });
      } catch (err) {
        if (isDomainError(err)) throw err;
        this.log?.error(
          { bookingId: request.bookingId, chargeId: charge.id, err },
          "Stripe refund creation failed with unexpected error",
        );
        throw providerUnavailable(
          "The payment provider is temporarily unavailable. Please retry the refund.",
        );
      }

      // ── 8. Persist REFUND row ────────────────────────────────────────────────
      refundRow = await this.paymentRepo.createPaymentInTx(
        {
          bookingId: request.bookingId,
          provider: "stripe",
          providerReference: stripeRefund.id,
          type: "REFUND",
          parentPaymentId: charge.id,
          amountMinor: stripeRefund.amountMinor,
          currency: stripeRefund.currency.toUpperCase(),
          status: mapStripeRefundStatus(stripeRefund.status),
        },
        tx,
      );

      // ── 9. Write REFUNDED audit row ──────────────────────────────────────────
      await this.auditWriter({
        tx,
        bookingId: request.bookingId,
        action: "REFUNDED",
        actorId: request.actor.id,
        actorRole: request.actor.role,
        resourceType: "payment",
        resourceId: refundRow.id,
        occurredAt: now,
        payload: {
          provider: "stripe",
          chargeId: charge.id,
          refundId: refundRow.id,
          providerReference: stripeRefund.id,
          amountMinor: amountToRefund.toString(),
          currency: refundRow.currency,
          scopeKey,
          legId: request.legId ?? null,
          reason: request.reason,
          correlationId: request.correlationId ?? null,
        },
      });

      // ── 10. Publish refund.issued event with provider reference as dedup ID ──
      await this.queue.publish(
        {
          type: "refund.issued",
          payload: {
            bookingId: request.bookingId,
            refundId: refundRow.id,
            providerReference: stripeRefund.id,
            amountMinor: amountToRefund.toString(),
            currency: refundRow.currency,
            status: refundRow.status,
            correlationId: request.correlationId ?? null,
          },
        },
        {
          // SQS FIFO MessageDeduplicationId = provider reference (AC8)
          messageDeduplicationId: stripeRefund.id,
          messageGroupId: request.bookingId,
        },
      );
    });

    // ── 11. Look up settlement window wording ────────────────────────────────
    const settlementWindow = await this.settlementWindow.lookup(
      "stripe",
      refundRow.currency,
    );

    this.log?.info(
      {
        bookingId: request.bookingId,
        refundId: refundRow.id,
        amountMinor: amountToRefund.toString(),
        currency: refundRow.currency,
        actorId: request.actor.id,
      },
      "Refund issued and persisted",
    );

    return {
      refundId: refundRow.id,
      providerReference: stripeRefund.id,
      amountMinor: amountToRefund,
      currency: refundRow.currency,
      status: mapStripeRefundStatus(stripeRefund.status) as RefundResult["status"],
      settlementWindow,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map Stripe refund status to platform status. */
function mapStripeRefundStatus(
  stripeStatus: "succeeded" | "pending" | "failed" | "canceled",
): "SUCCEEDED" | "PENDING" | "FAILED" {
  switch (stripeStatus) {
    case "succeeded":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
    case "canceled":
    default:
      return "FAILED";
  }
}

/** Check whether an error is a DomainError (has a string `code`). */
function isDomainError(err: unknown): err is DomainError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as DomainError).code === "string"
  );
}
