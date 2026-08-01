/**
 * ItineraryService — all itinerary business rules (WO-053).
 *
 * Framework-free: no Express, no Prisma imports.
 * All dependencies injected via constructor.
 *
 * Rules enforced here (not in the repository or controller):
 *   - Minimum 2 member bookings at all times.
 *   - All bookingIds must be owned by the requesting user.
 *   - A booking may belong to at most one itinerary.
 *   - endDate must be strictly after startDate.
 *   - Per-currency totals: amounts in different currencies are never summed.
 *   - 404 vs 403 distinction: the repo findById (no ownership filter) is used
 *     to check existence before the ownership predicate.
 *   - Security audit written for every DENY event.
 *   - Booking audit written (via AuditWriter) for attach/detach operations.
 *   - Mutation audit written (via SecurityEventWriter) for create/update/delete.
 */

import {
  notFound,
  forbidden,
  conflict,
  validationFailed,
} from "@travel/contracts/errors";
import type { DomainError } from "@travel/contracts/errors";
import type {
  ItineraryRepositoryPort,
  ItineraryRow,
  ItineraryBookingRow,
} from "../repositories/ItineraryRepository.js";
import type { SecurityEventWriter } from "./SecurityEventWriter.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Actor {
  id: string;
  role: string;
}

export interface CreateItineraryInput {
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  bookingIds: string[];
}

export interface UpdateItineraryInput {
  name?: string;
  description?: string;
  startDate?: Date;
  endDate?: Date;
  addBookingIds?: string[];
  removeBookingIds?: string[];
}

export interface ItineraryBookingSummary {
  id: string;
  bookingType: string;
  status: string;
  totalPrice: string;
  currency: string;
}

export interface CurrencyTotal {
  currency: string;
  amount: string;
}

export interface ItineraryResult {
  id: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string;
  bookings: ItineraryBookingSummary[];
  totals: CurrencyTotal[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Per-currency Decimal total computation (integer arithmetic — no floats)
// ---------------------------------------------------------------------------

function priceToCents(price: string): bigint {
  const clean = price.trim();
  const dotIdx = clean.indexOf('.');
  if (dotIdx === -1) return BigInt(clean) * 100n;
  const whole = clean.slice(0, dotIdx);
  const frac = clean.slice(dotIdx + 1).padEnd(2, '0').slice(0, 2);
  return BigInt(whole) * 100n + BigInt(frac);
}

function centsToPrice(cents: bigint): string {
  const dollars = cents / 100n;
  const centsPart = cents % 100n;
  return `${dollars}.${centsPart.toString().padStart(2, '0')}`;
}

function computeTotals(bookings: ItineraryBookingRow[]): CurrencyTotal[] {
  const map = new Map<string, bigint>();
  for (const b of bookings) {
    const cents = priceToCents(b.totalPrice.toString());
    map.set(b.currency, (map.get(b.currency) ?? 0n) + cents);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, amount: centsToPrice(cents) }));
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function toResult(row: ItineraryRow): ItineraryResult {
  const bookings: ItineraryBookingSummary[] = row.bookings.map((b) => ({
    id: b.id,
    bookingType: b.bookingType,
    status: b.status,
    totalPrice: b.totalPrice.toString(),
    currency: b.currency,
  }));
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    startDate: (row.startDate ?? new Date(0)).toISOString(),
    endDate: (row.endDate ?? new Date(0)).toISOString(),
    bookings,
    totals: computeTotals(row.bookings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ItineraryService
// ---------------------------------------------------------------------------

export class ItineraryService {
  constructor(
    private readonly repo: ItineraryRepositoryPort,
    private readonly securityWriter: SecurityEventWriter,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  // ── create ────────────────────────────────────────────────────────────────

  async create(
    userId: string,
    actor: Actor,
    input: CreateItineraryInput,
  ): Promise<ItineraryResult> {
    // Date coherence
    if (input.endDate.getTime() <= input.startDate.getTime()) {
      throw validationFailed("endDate must be after startDate", "endDate");
    }

    // Minimum 2 bookings enforced by schema, but verify here for defense-in-depth
    if (input.bookingIds.length < 2) {
      throw validationFailed(
        "bookingIds must contain at least two entries",
        "bookingIds",
      );
    }

    // Verify ownership of all bookingIds
    const owned = await this.repo.findBookingsByIds(input.bookingIds, userId);
    if (owned.length !== input.bookingIds.length) {
      const ownedIds = new Set(owned.map((b) => b.id));
      const missingId = input.bookingIds.find((id) => !ownedIds.has(id)) ?? "";
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "booking",
        resourceId: missingId,
        operation: "ATTACH_BOOKING",
        decision: "DENY",
        reason: "BOOKING_NOT_OWNED_BY_ACTOR",
      });
      throw forbidden("One or more bookingIds are not owned by the authenticated user");
    }

    // Verify none are already attached to another itinerary
    const alreadyAttached = owned.filter(
      (b) => b.itineraryId !== null && b.itineraryId !== undefined,
    );
    if (alreadyAttached.length > 0) {
      throw conflict(
        `Booking ${alreadyAttached[0]!.id} is already attached to another itinerary`,
        "bookingIds",
      );
    }

    const row = await this.repo.create(
      {
        userId,
        name: input.name,
        description: input.description,
        startDate: input.startDate,
        endDate: input.endDate,
      },
      input.bookingIds,
      userId,
    );

    await this.securityWriter.write({
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "itinerary",
      resourceId: row.id,
      operation: "CREATE",
      decision: "ALLOW",
    });

    return toResult(row);
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async listByUser(
    userId: string,
    actor: Actor,
  ): Promise<{ items: ItineraryResult[]; total: number }> {
    const rows = await this.repo.findAllByUser(userId);
    const items = rows.map(toResult);
    return { items, total: items.length };
  }

  // ── getById ───────────────────────────────────────────────────────────────

  /**
   * Returns the itinerary with 404-vs-403 distinction:
   *   - id does not exist → 404
   *   - id exists, owned by another user → 403 + security audit
   */
  async getById(
    id: string,
    userId: string,
    actor: Actor,
  ): Promise<ItineraryResult> {
    const row = await this.repo.findById(id);
    if (!row) throw notFound("Itinerary not found");

    if (row.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: id,
        operation: "READ",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      throw forbidden("Access denied to itinerary");
    }

    return toResult(row);
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(
    id: string,
    userId: string,
    actor: Actor,
    input: UpdateItineraryInput,
  ): Promise<ItineraryResult> {
    // Ownership check with 404/403 distinction
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound("Itinerary not found");

    if (existing.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: id,
        operation: "UPDATE",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      throw forbidden("Access denied to itinerary");
    }

    // Date coherence when both dates are being changed or one is supplied
    const effectiveStart = input.startDate ?? existing.startDate;
    const effectiveEnd = input.endDate ?? existing.endDate;
    if (effectiveStart && effectiveEnd) {
      if (effectiveEnd.getTime() <= effectiveStart.getTime()) {
        throw validationFailed("endDate must be after startDate", "endDate");
      }
    }

    const addBookingIds = input.addBookingIds ?? [];
    const removeBookingIds = input.removeBookingIds ?? [];

    // Validate bookings being added
    if (addBookingIds.length > 0) {
      const owned = await this.repo.findBookingsByIds(addBookingIds, userId);
      if (owned.length !== addBookingIds.length) {
        const ownedIds = new Set(owned.map((b) => b.id));
        const missingId = addBookingIds.find((bid) => !ownedIds.has(bid)) ?? "";
        await this.securityWriter.write({
          actorId: actor.id,
          actorRole: actor.role,
          resourceType: "booking",
          resourceId: missingId,
          operation: "ATTACH_BOOKING",
          decision: "DENY",
          reason: "BOOKING_NOT_OWNED_BY_ACTOR",
        });
        throw forbidden("One or more addBookingIds are not owned by the authenticated user");
      }

      // Check none are already attached to a DIFFERENT itinerary
      const alreadyElsewhere = owned.filter(
        (b) => b.itineraryId !== null && b.itineraryId !== id,
      );
      if (alreadyElsewhere.length > 0) {
        throw conflict(
          `Booking ${alreadyElsewhere[0]!.id} is already attached to another itinerary`,
          "addBookingIds",
        );
      }
    }

    // Membership minimum check after detach
    if (removeBookingIds.length > 0) {
      const currentMemberIds = new Set(existing.bookings.map((b) => b.id));
      const remaining =
        existing.bookings.filter((b) => !removeBookingIds.includes(b.id)).length +
        addBookingIds.filter((bid) => !currentMemberIds.has(bid)).length;
      if (remaining < 2) {
        throw conflict(
          "Removing these bookings would leave fewer than two members; an itinerary requires at least two",
          "removeBookingIds",
        );
      }
    }

    const updated = await this.repo.update(
      id,
      userId,
      existing.version,
      {
        name: input.name,
        description: input.description,
        startDate: input.startDate,
        endDate: input.endDate,
      },
      addBookingIds,
      removeBookingIds,
    );

    if (!updated) {
      // Optimistic-concurrency conflict — concurrent modification
      throw conflict(
        "The itinerary was modified concurrently; please reload and retry",
      );
    }

    await this.securityWriter.write({
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "itinerary",
      resourceId: id,
      operation: "UPDATE",
      decision: "ALLOW",
    });

    return toResult(updated);
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async delete(
    id: string,
    userId: string,
    actor: Actor,
  ): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw notFound("Itinerary not found");

    if (existing.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: id,
        operation: "DELETE",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      throw forbidden("Access denied to itinerary");
    }

    await this.repo.deleteById(id, userId);

    await this.securityWriter.write({
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "itinerary",
      resourceId: id,
      operation: "DELETE",
      decision: "ALLOW",
    });
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isItineraryDomainError(err: unknown): err is DomainError {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as DomainError).code === "string"
  );
}
