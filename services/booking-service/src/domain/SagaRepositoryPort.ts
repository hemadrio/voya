/**
 * SagaRepositoryPort — hexagonal port for persisting checkout saga state.
 *
 * The orchestrator uses this port exclusively; no Prisma types appear in
 * the orchestrator. Implementations wire a real PrismaClient at startup.
 *
 * Persistence guarantee: every state change is written before any external
 * supplier call, so a crash cannot lose knowledge of an outstanding hold.
 */

// ---------------------------------------------------------------------------
// Domain value types
// ---------------------------------------------------------------------------

export type SagaStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'FAILED';

export type LegStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'COMMITTED'
  | 'FAILED'
  | 'COMPENSATED';

export type SagaPolicy = 'FAIL_WHOLE';

// ---------------------------------------------------------------------------
// Saga aggregate
// ---------------------------------------------------------------------------

export interface SagaRow {
  id: string;
  bookingId: string;
  itineraryId: string | null;
  status: SagaStatus;
  policy: SagaPolicy;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Saga leg
// ---------------------------------------------------------------------------

export interface LegRow {
  id: string;
  sagaId: string;
  offerId: string;
  supplier: string;
  flowType: 'instant' | 'reserveThenConfirm';
  travelCategory: string;
  status: LegStatus;
  supplierReference: string | null;
  amountMinor: bigint;
  currency: string;
  attemptCount: number;
  lastError: string | null;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Create / update inputs
// ---------------------------------------------------------------------------

export interface CreateSagaInput {
  bookingId: string;
  itineraryId?: string;
  policy?: SagaPolicy;
  correlationId: string;
  legs: CreateLegInput[];
}

export interface CreateLegInput {
  offerId: string;
  supplier: string;
  flowType: 'instant' | 'reserveThenConfirm';
  travelCategory: string;
  amountMinor: bigint;
  currency: string;
}

export interface UpdateLegInput {
  status?: LegStatus;
  supplierReference?: string;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// SagaRepositoryPort interface
// ---------------------------------------------------------------------------

export interface SagaRepositoryPort {
  /**
   * Persist a new saga with all its legs in PENDING status.
   * Throws a conflict error if a saga already exists for the booking.
   */
  create(input: CreateSagaInput): Promise<SagaRow & { legs: LegRow[] }>;

  /**
   * Load a saga by id including all legs.
   * Returns null when not found.
   */
  findById(sagaId: string): Promise<(SagaRow & { legs: LegRow[] }) | null>;

  /**
   * Find the active saga for a booking (status RUNNING or COMPENSATING).
   * Returns null when not found.
   */
  findActiveByBookingId(bookingId: string): Promise<(SagaRow & { legs: LegRow[] }) | null>;

  /**
   * Find all RUNNING sagas whose updated_at is older than the given date.
   * Used by the resume job.
   */
  findStaleSagas(staleBefore: Date, limit?: number): Promise<SagaRow[]>;

  /**
   * Update the saga status.
   */
  updateSagaStatus(sagaId: string, status: SagaStatus): Promise<void>;

  /**
   * Update a single leg's status and optional fields.
   * The updated_at timestamp on the saga is also bumped.
   */
  updateLeg(legId: string, input: UpdateLegInput): Promise<LegRow>;

  /**
   * Increment the attempt count on a leg.
   */
  incrementAttemptCount(legId: string): Promise<void>;
}
