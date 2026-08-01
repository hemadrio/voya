/**
 * RefundPort — hexagonal port for issuing refunds during saga compensation.
 *
 * Implementations call the payment-service RefundService or write directly
 * to the payments table (REFUND row linked to the original CHARGE via
 * parent_payment_id). The port is injected into CheckoutSagaOrchestrator.
 */

// ---------------------------------------------------------------------------
// Refund request / result
// ---------------------------------------------------------------------------

export interface RefundRequest {
  /** Booking id for correlation. */
  bookingId: string;
  /** Saga leg id — used as idempotency key so a retry cannot double-refund. */
  legId: string;
  /** Amount to refund in the currency's minor unit. */
  amountMinor: bigint;
  currency: string;
  /** Provider-specific booking reference from the supplier. */
  supplierReference: string;
  /** Human-readable reason for the compensation. */
  reason: string;
  /** Correlation id of the originating checkout for audit. */
  correlationId: string;
}

export interface RefundResult {
  refundId: string;
  status: 'PENDING' | 'ISSUED';
}

// ---------------------------------------------------------------------------
// RefundPort interface
// ---------------------------------------------------------------------------

export interface RefundPort {
  /**
   * Issue a refund for a compensated leg.
   *
   * Implementations must be idempotent on legId — a second call with the
   * same legId returns the original result without creating a duplicate row.
   *
   * Throws on persistent failure; the orchestrator records the exception
   * and marks the saga as FAILED for manual reconciliation.
   */
  issueRefund(request: RefundRequest): Promise<RefundResult>;
}
