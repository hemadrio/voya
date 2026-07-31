/**
 * BookingCreationService — domain service for PENDING booking creation (WO-039).
 *
 * Responsibilities:
 *   1. Resolve the selected offer via OfferPort (404 if unknown/evicted).
 *   2. Assert provenance is a real supplier channel via assertBookable (422 OFFER_NOT_BOOKABLE
 *      for ILLUSTRATIVE or non-bookable offers).
 *   3. Assert the offer has not yet expired at creation time (409 OFFER_EXPIRED).
 *   4. Build an immutable offer snapshot (decimal-string price, no float arithmetic).
 *   5. Handle duplicate creates via idempotency key (return original on repeat).
 *   6. Persist the PENDING booking + offer snapshot in the repository.
 *
 * Invariants:
 *   - Domain service imports neither Express nor PrismaClient.
 *   - All collaborators are injected via the constructor.
 *   - The resolved offer's price always wins; client-supplied price is logged
 *     as a warn and discarded.
 *   - expiresAt = now + PENDING_WINDOW_MS (default 30 minutes).
 */

import { assertBookable } from "./ProvenanceGuard.js";
import { notFound, offerExpired } from "@travel/contracts/errors";
import type { CreateBookingRequest } from "@travel/contracts/booking";
import type { OfferSnapshot } from "@travel/contracts/booking";
import type { OfferPort, ResolvedOffer } from "./OfferPort.js";

// ---------------------------------------------------------------------------
// PENDING window constant
// ---------------------------------------------------------------------------

/** How long a PENDING booking survives before it is considered abandoned. */
export const PENDING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Injectable interfaces — no Prisma, no Express
// ---------------------------------------------------------------------------

export interface CreateBookingInput {
  userId: string;
  bookingType: string;
  offerId: string;
  offerSnapshot: OfferSnapshot;
  totalPrice: string;
  currency: string;
  provenance: string;
  contactEmail: string;
  contactPhone?: string | null;
  idempotencyKey: string;
  expiresAt: Date;
  status: "PENDING";
}

export interface CreatedBooking {
  id: string;
  idempotencyKey: string;
  status: string;
  totalPrice: string;
  currency: string;
  expiresAt: Date | null;
  provenance: string | null;
  offerSnapshot: Record<string, unknown>;
}

export interface BookingRepositoryPort {
  createBooking(input: CreateBookingInput): Promise<CreatedBooking>;
  findByIdempotencyKey(idempotencyKey: string): Promise<CreatedBooking | null>;
}

/** Minimal structured-logger interface (duck-typed subset of pino.Logger). */
export interface CreationLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// AuditWriterPort — write the creation audit entry (AC6)
// ---------------------------------------------------------------------------

/**
 * Payload for a booking-created audit entry.
 * The concrete implementation (BookingRepository transactional write) handles
 * persisting this alongside the booking row in a single transaction so the two
 * records are either both committed or both rolled back (WO-041 scope).
 */
export interface AuditEntry {
  bookingId: string;
  action: string;
  actorId: string;
  actorRole: string;
  /** Sanitised offer snapshot stored as the "new state" of the audit row. */
  payload: Record<string, unknown>;
  occurredAt: Date;
  correlationId?: string;
}

/**
 * Port for writing immutable booking audit entries (WO-039 / WO-041).
 *
 * The concrete implementation performs the write inside the same Prisma
 * transaction as the booking INSERT so neither can exist without the other.
 * The domain service calls this after a successful booking creation.
 */
export interface AuditWriterPort {
  write(entry: AuditEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CreatedBookingResult {
  bookingId: string;
  status: "PENDING";
  totalPrice: string;
  currency: string;
  expiresAt: Date;
  provenance: string;
  offerSnapshot: OfferSnapshot;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface BookingCreationDeps {
  offerPort: OfferPort;
  bookingRepository: BookingRepositoryPort;
  /**
   * Audit writer injected at startup (AC6).
   * When provided, a BOOKING_CREATED audit entry is written for every
   * successful create call.  When omitted (e.g. lightweight unit tests that
   * don't need audit coverage), the write is skipped without error.
   */
  auditWriter?: AuditWriterPort;
  /** Injected clock — defaults to `() => new Date()`. Override in tests. */
  clock?: () => Date;
  /** Optional structured logger for warn-level price-mismatch events. */
  log?: CreationLogger;
}

// ---------------------------------------------------------------------------
// BookingCreationService
// ---------------------------------------------------------------------------

export class BookingCreationService {
  private readonly offerPort: OfferPort;
  private readonly bookingRepository: BookingRepositoryPort;
  private readonly auditWriter: AuditWriterPort | undefined;
  private readonly clock: () => Date;
  private readonly log: CreationLogger | undefined;

  constructor(deps: BookingCreationDeps) {
    this.offerPort = deps.offerPort;
    this.bookingRepository = deps.bookingRepository;
    this.auditWriter = deps.auditWriter;
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log;
  }

  /**
   * Create a PENDING booking from a validated create request.
   *
   * @param request       - Validated CreateBookingRequest from Zod schema.
   * @param userId        - Authenticated user ID (from JWT sub claim).
   * @param idempotencyKey - Client-supplied idempotency key (must be unique per create attempt).
   * @returns The created booking metadata.
   */
  async create(
    request: CreateBookingRequest,
    userId: string,
    idempotencyKey: string,
  ): Promise<CreatedBookingResult> {
    // Step 1: Idempotency — return original if already created.
    const existing = await this.bookingRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return this.toResult(existing);
    }

    const now = this.clock();

    // Step 2: Resolve the offer via the port (404 if unknown/evicted).
    const offer = await this.offerPort.resolveOffer(request.offerId);
    if (!offer) {
      throw notFound(
        `Offer "${request.offerId}" was not found or has been evicted from the search cache. Please search again.`,
      );
    }

    // Step 3: Validate provenance — throws 422 OFFER_NOT_BOOKABLE for ILLUSTRATIVE.
    try {
      assertBookable({ provenance: offer.provenance, bookable: offer.bookable });
    } catch (err) {
      // AC4: emit structured warn so audit tooling can detect non-bookable attempts.
      if (this.log) {
        this.log.warn(
          { offerId: request.offerId, provenance: offer.provenance, userId },
          "Offer rejected: provenance is not a real supplier or offer is non-bookable",
        );
      }
      throw err;
    }

    // Step 4: Check offer has not expired at create time.
    if (offer.expiresAt !== undefined && offer.expiresAt <= now) {
      throw offerExpired();
    }

    // Step 5: Log price mismatch — server price wins, client price is discarded.
    const resolvedPriceStr = formatPrice(offer.totalPrice);
    const clientPriceStr =
      typeof request.offerPrice === "number"
        ? formatPrice(request.offerPrice)
        : String(request.offerPrice);

    if (resolvedPriceStr !== clientPriceStr && this.log) {
      this.log.warn(
        {
          offerId: request.offerId,
          clientPrice: clientPriceStr,
          resolvedPrice: resolvedPriceStr,
          userId,
        },
        "Client-supplied price differs from resolved offer price; server price wins",
      );
    }

    // Step 6: Build immutable offer snapshot.
    const offerSnapshot = buildSnapshot(offer);

    // Step 7: Calculate PENDING window expiry.
    const expiresAt = new Date(now.getTime() + PENDING_WINDOW_MS);

    // Step 8: Persist — repository handles the DB write.
    const booking = await this.bookingRepository.createBooking({
      userId,
      bookingType: request.bookingType,
      offerId: request.offerId,
      offerSnapshot,
      totalPrice: resolvedPriceStr,
      currency: offer.currency,
      provenance: offer.provenance,
      contactEmail: request.contactEmail,
      contactPhone: request.contactPhone ?? null,
      idempotencyKey,
      expiresAt,
      status: "PENDING",
    });

    // Step 9: Write BOOKING_CREATED audit entry (AC6).
    // The concrete AuditWriterPort implementation performs this write inside
    // the same Prisma transaction as the booking INSERT (WO-041 scope).
    if (this.auditWriter) {
      await this.auditWriter.write({
        bookingId: booking.id,
        action: "BOOKING_CREATED",
        actorId: userId,
        actorRole: "traveler",
        payload: offerSnapshot as Record<string, unknown>,
        occurredAt: now,
      });
    }

    if (this.log) {
      this.log.info(
        { bookingId: booking.id, userId, offerId: request.offerId, provenance: offer.provenance },
        "PENDING booking created",
      );
    }

    return this.toResult(booking);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private toResult(booking: CreatedBooking): CreatedBookingResult {
    return {
      bookingId: booking.id,
      status: "PENDING",
      totalPrice: booking.totalPrice,
      currency: booking.currency,
      expiresAt: booking.expiresAt ?? new Date(this.clock().getTime() + PENDING_WINDOW_MS),
      provenance: booking.provenance ?? "",
      offerSnapshot: booking.offerSnapshot as OfferSnapshot,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Serialise a number to a decimal string with exactly two decimal places
 * (e.g. 412.5 → "412.50").  Prisma Decimal values have a `.toString()` that
 * already produces this format; for JS numbers we use toFixed(2).
 * No floating-point arithmetic — the input number is expected to have at
 * most two decimal places (validated earlier by the Zod schema).
 */
function formatPrice(value: number): string {
  return value.toFixed(2);
}

/**
 * Build the immutable OfferSnapshot from the resolved offer.
 * Serialises price as a decimal string to avoid float artefacts in JSONB.
 */
function buildSnapshot(offer: ResolvedOffer): OfferSnapshot {
  const snapshot: OfferSnapshot = {
    offerId: offer.offerId,
    provenance: offer.provenance as OfferSnapshot["provenance"],
    supplier: offer.supplier,
    totalPrice: formatPrice(offer.totalPrice),
    currency: offer.currency.toUpperCase() as OfferSnapshot["currency"],
    bookable: offer.bookable,
  };

  if (offer.expiresAt !== undefined) {
    snapshot.expiresAt = offer.expiresAt.toISOString();
  }

  if (offer.legs.length > 0) {
    snapshot.legs = offer.legs.map((leg) => ({
      offerId: leg.offerId,
      supplier: leg.supplier,
      provenance: leg.provenance,
      ...(leg.origin !== undefined && { origin: leg.origin }),
      ...(leg.destination !== undefined && { destination: leg.destination }),
      ...(leg.departureAt !== undefined && { departureAt: leg.departureAt.toISOString() }),
      ...(leg.arrivalAt !== undefined && { arrivalAt: leg.arrivalAt.toISOString() }),
      ...(leg.checkInDate !== undefined && { checkInDate: leg.checkInDate }),
      ...(leg.checkOutDate !== undefined && { checkOutDate: leg.checkOutDate }),
      ...(leg.pickUpDate !== undefined && { pickUpDate: leg.pickUpDate }),
      ...(leg.dropOffDate !== undefined && { dropOffDate: leg.dropOffDate }),
    }));
  }

  return snapshot;
}
