/**
 * CheckoutSupplierPort — booking-service hexagonal port for saga supplier commits.
 *
 * This port is distinct from @travel/supplier-port (which is used for search).
 * It models the commit-phase protocol needed by CheckoutSagaOrchestrator:
 *
 *   instant:             commit() → supplier_reference
 *   reserveThenConfirm:  reserve() → token, then confirm(token)
 *
 * Both methods accept a caller-supplied idempotencyRef derived from the saga
 * leg id so the supplier can deduplicate retries without double-booking.
 *
 * All errors thrown must be one of SupplierCommitError variants so the
 * orchestrator can classify them into 422, 502 or 504 for the traveler.
 */

// ---------------------------------------------------------------------------
// Flow type discriminant
// ---------------------------------------------------------------------------

/** The booking protocol an adapter supports. */
export type SupplierFlowType = 'instant' | 'reserveThenConfirm';

// ---------------------------------------------------------------------------
// Commit result
// ---------------------------------------------------------------------------

/** Returned by commit() and confirm() to identify the supplier booking. */
export interface SupplierCommitResult {
  /** Opaque provider reference (PNR, hotel reservation number, etc.). */
  readonly supplierReference: string;
}

/** Token returned by reserve(); passed back to confirm() or cancelReserve(). */
export interface SupplierReserveToken {
  readonly supplierName: string;
  readonly providerRef: string;
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Base for all supplier errors thrown from this port. */
export class SupplierCommitError extends Error {
  constructor(
    readonly supplierName: string,
    readonly legId: string,
    message: string,
    /** HTTP-semantic classification: 422 = rejected, 502 = unavailable, 504 = timeout. */
    readonly kind: 'rejected' | 'unavailable' | 'timeout',
  ) {
    super(message);
    this.name = 'SupplierCommitError';
  }
}

// ---------------------------------------------------------------------------
// CheckoutSupplierPort interface
// ---------------------------------------------------------------------------

/**
 * Contract every supplier adapter must implement for saga commit operations.
 *
 * Constraints:
 *  - No provider-specific fields in parameters or return types.
 *  - flowType determines which methods are valid to call.
 *  - All errors must be SupplierCommitError instances.
 *  - Implementations must pass idempotencyRef verbatim to the provider.
 */
export interface CheckoutSupplierPort {
  /** Human-readable supplier name for error messages and audit logs. */
  readonly supplierName: string;

  /** Whether this adapter uses instant or reserve-then-confirm protocol. */
  readonly flowType: SupplierFlowType;

  /**
   * Instant-flow commit.
   * Valid only when flowType === 'instant'.
   *
   * @param offerId        - The offer to book.
   * @param idempotencyRef - Derived from saga leg id; passed to provider for dedup.
   * @param correlationId  - Correlation ID of the originating checkout.
   */
  commit(
    offerId: string,
    idempotencyRef: string,
    correlationId: string,
  ): Promise<SupplierCommitResult>;

  /**
   * Reserve-then-confirm: place a hold.
   * Valid only when flowType === 'reserveThenConfirm'.
   *
   * The token MUST be persisted by the orchestrator before calling confirm().
   * If the service crashes after reserve() but before confirm(), the token
   * is used to either confirm or cancel on resume.
   */
  reserve(
    offerId: string,
    idempotencyRef: string,
    correlationId: string,
  ): Promise<SupplierReserveToken>;

  /**
   * Reserve-then-confirm: confirm a held reservation.
   * Valid only when flowType === 'reserveThenConfirm'.
   */
  confirm(
    token: SupplierReserveToken,
    idempotencyRef: string,
    correlationId: string,
  ): Promise<SupplierCommitResult>;

  /**
   * Cancel a committed booking or release a held reservation.
   * Called during saga compensation. Must be idempotent (a second call
   * for an already-cancelled reference is a no-op, not an error).
   *
   * @param supplierReference - The provider reference from commit/confirm.
   * @param idempotencyRef    - Derived from saga leg id + "-cancel".
   */
  cancel(
    supplierReference: string,
    idempotencyRef: string,
    correlationId: string,
  ): Promise<void>;

  /**
   * Release an outstanding reserve token without confirming.
   * Called when a later leg fails and the reserved leg must be unwound.
   * Must be idempotent.
   */
  cancelReserve(
    token: SupplierReserveToken,
    idempotencyRef: string,
    correlationId: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// SupplierPortRegistry — maps supplier names to their adapters
// ---------------------------------------------------------------------------

export interface SupplierPortRegistry {
  /**
   * Look up an adapter by supplier name.
   * Returns undefined when no adapter is registered, which the orchestrator
   * treats as a configuration error (500).
   */
  get(supplierName: string): CheckoutSupplierPort | undefined;
}
