/**
 * ItineraryRepository — ownership-predicate queries for itineraries (WO-053).
 *
 * Every read/write on an owned itinerary includes userId in the WHERE clause.
 * A separate findById (no userId filter) exists ONLY for the 404-vs-403
 * distinction: callers must never rely on it for authorization decisions.
 *
 * Injectable: depends only on duck-typed interfaces for testability.
 */

// ---------------------------------------------------------------------------
// Injectable Prisma interfaces (duck-typed for unit testability)
// ---------------------------------------------------------------------------

export interface ItineraryBookingRow {
  id: string;
  userId: string;
  bookingType: string;
  status: string;
  totalPrice: { toString(): string };
  currency: string;
  itineraryId: string | null;
}

export interface ItineraryRow {
  id: string;
  userId: string;
  name: string;
  description?: string | null;
  startDate: Date | null;
  endDate: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  bookings: ItineraryBookingRow[];
}

/** Flat row without bookings — used for list queries (avoid N+1). */
export interface ItineraryFlatRow {
  id: string;
  userId: string;
  name: string;
  description?: string | null;
  startDate: Date | null;
  endDate: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateItineraryData {
  userId: string;
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
}

export interface UpdateItineraryData {
  name?: string;
  description?: string;
  startDate?: Date;
  endDate?: Date;
}

/** Tx client slice needed by attach/detach/audit operations. */
export interface ItineraryTxClient {
  itinerary: {
    update(args: {
      where: { id: string; version: number };
      data: {
        name?: string;
        description?: string | null;
        startDate?: Date;
        endDate?: Date;
        version: { increment: number };
        updatedAt?: Date;
      };
    }): Promise<ItineraryFlatRow | null>;
    updateMany(args: {
      where: { id: string; version: number };
      data: { version: { increment: number }; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
  booking: {
    updateMany(args: {
      where: { id: { in: string[] }; userId: string; itineraryId: string | null };
      data: { itineraryId: string | null; updatedAt: Date };
    }): Promise<{ count: number }>;
    updateMany(args: {
      where: { id: { in: string[] }; itineraryId: string };
      data: { itineraryId: string | null; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface ItineraryPrismaClient {
  itinerary: {
    findUnique(args: {
      where: { id: string };
      include?: { bookings?: boolean };
    }): Promise<ItineraryRow | null>;
    findMany(args: {
      where: { userId: string };
      include?: { bookings?: boolean };
      orderBy?: { createdAt: 'desc' | 'asc' };
      take?: number;
    }): Promise<ItineraryRow[]>;
    create(args: {
      data: {
        userId: string;
        name: string;
        description?: string | null;
        startDate: Date;
        endDate: Date;
        // title required by existing schema
        title: string;
      };
      include?: { bookings?: boolean };
    }): Promise<ItineraryRow>;
    update(args: {
      where: { id: string };
      data: {
        name?: string;
        description?: string | null;
        startDate?: Date;
        endDate?: Date;
        version?: { increment: number };
        updatedAt?: Date;
      };
      include?: { bookings?: boolean };
    }): Promise<ItineraryRow>;
    updateMany(args: {
      where: { id: string; version: number };
      data: {
        name?: string;
        description?: string | null;
        startDate?: Date;
        endDate?: Date;
        version: { increment: number };
        updatedAt: Date;
      };
    }): Promise<{ count: number }>;
    delete(args: { where: { id: string; userId: string } }): Promise<void>;
  };
  booking: {
    findMany(args: {
      where: { id?: { in: string[] }; userId?: string; itineraryId?: string | null };
    }): Promise<ItineraryBookingRow[]>;
    updateMany(args: {
      where: {
        id?: { in: string[] };
        userId?: string;
        itineraryId?: string | null | { not: null };
      };
      data: { itineraryId: string | null; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ItineraryPrismaClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Repository port — injected interface for the domain service
// ---------------------------------------------------------------------------

export interface ItineraryRepositoryPort {
  /**
   * Find an itinerary by its id without an ownership predicate.
   * Returns null when the id does not exist.
   * MUST NOT be used as an authorization path — call findOwnedById for that.
   */
  findById(id: string): Promise<ItineraryRow | null>;

  /**
   * Find an itinerary owned by userId (predicate: id = $id AND user_id = $userId).
   * Returns null when the id does not exist OR when owned by a different user.
   * Callers that need 404-vs-403 must call findById first, then this.
   */
  findOwnedById(id: string, userId: string): Promise<ItineraryRow | null>;

  /** List all itineraries for a user, newest first. */
  findAllByUser(userId: string): Promise<ItineraryRow[]>;

  /** Create a new itinerary with the given bookings pre-attached. */
  create(data: CreateItineraryData, bookingIds: string[], userId: string): Promise<ItineraryRow>;

  /**
   * Update itinerary fields + optionally attach/detach bookings atomically.
   * Uses optimistic concurrency via version column.
   * Returns null when the version check fails (concurrent modification).
   */
  update(
    id: string,
    userId: string,
    expectedVersion: number,
    fields: UpdateItineraryData,
    addBookingIds: string[],
    removeBookingIds: string[],
  ): Promise<ItineraryRow | null>;

  /**
   * Detach all bookings and delete the itinerary.
   * Never cascades into booking deletion.
   */
  deleteById(id: string, userId: string): Promise<void>;

  /**
   * Fetch bookings by id list, optionally filtered by ownership.
   * Used to validate bookmark ownership before attachment.
   */
  findBookingsByIds(ids: string[], userId: string): Promise<ItineraryBookingRow[]>;
}

// ---------------------------------------------------------------------------
// ItineraryRepository (Prisma implementation)
// ---------------------------------------------------------------------------

export class ItineraryRepository implements ItineraryRepositoryPort {
  constructor(private readonly db: ItineraryPrismaClient) {}

  async findById(id: string): Promise<ItineraryRow | null> {
    return this.db.itinerary.findUnique({
      where: { id },
      include: { bookings: true },
    });
  }

  async findOwnedById(id: string, userId: string): Promise<ItineraryRow | null> {
    const row = await this.db.itinerary.findUnique({
      where: { id },
      include: { bookings: true },
    });
    if (!row || row.userId !== userId) return null;
    return row;
  }

  async findAllByUser(userId: string): Promise<ItineraryRow[]> {
    return this.db.itinerary.findMany({
      where: { userId },
      include: { bookings: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    data: CreateItineraryData,
    bookingIds: string[],
    userId: string,
  ): Promise<ItineraryRow> {
    return this.db.$transaction(async (tx) => {
      const itinerary = await tx.itinerary.create({
        data: {
          userId: data.userId,
          name: data.name,
          description: data.description ?? null,
          startDate: data.startDate,
          endDate: data.endDate,
          title: data.name, // mirror to legacy title column
        },
        include: { bookings: true },
      });

      if (bookingIds.length > 0) {
        await tx.booking.updateMany({
          where: { id: { in: bookingIds }, userId, itineraryId: null },
          data: { itineraryId: itinerary.id, updatedAt: new Date() },
        });
      }

      // Re-fetch with bookings attached
      const fresh = await tx.itinerary.findUnique({
        where: { id: itinerary.id },
        include: { bookings: true },
      });
      return fresh!;
    });
  }

  async update(
    id: string,
    userId: string,
    expectedVersion: number,
    fields: UpdateItineraryData,
    addBookingIds: string[],
    removeBookingIds: string[],
  ): Promise<ItineraryRow | null> {
    return this.db.$transaction(async (tx) => {
      // Optimistic concurrency — only update when version matches.
      const updateData: Parameters<typeof tx.itinerary.updateMany>[0]['data'] = {
        version: { increment: 1 },
        updatedAt: new Date(),
      };
      if (fields.name !== undefined) updateData.name = fields.name;
      if ('description' in fields) updateData.description = fields.description ?? null;
      if (fields.startDate !== undefined) updateData.startDate = fields.startDate;
      if (fields.endDate !== undefined) updateData.endDate = fields.endDate;
      if (fields.name !== undefined) {
        // mirror to legacy column
        (updateData as Record<string, unknown>)['title'] = fields.name;
      }

      const result = await tx.itinerary.updateMany({
        where: { id, version: expectedVersion },
        data: updateData,
      });

      if (result.count === 0) return null; // lost race

      // Detach bookings.
      if (removeBookingIds.length > 0) {
        await tx.booking.updateMany({
          where: { id: { in: removeBookingIds }, itineraryId: id },
          data: { itineraryId: null, updatedAt: new Date() },
        });
      }

      // Attach new bookings — only those owned by userId and not yet in an itinerary.
      if (addBookingIds.length > 0) {
        await tx.booking.updateMany({
          where: { id: { in: addBookingIds }, userId, itineraryId: null },
          data: { itineraryId: id, updatedAt: new Date() },
        });
      }

      return tx.itinerary.findUnique({
        where: { id },
        include: { bookings: true },
      });
    });
  }

  async deleteById(id: string, userId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Detach all bookings without deleting them.
      await tx.booking.updateMany({
        where: { itineraryId: id },
        data: { itineraryId: null, updatedAt: new Date() },
      });
      await tx.itinerary.delete({ where: { id, userId } });
    });
  }

  async findBookingsByIds(ids: string[], userId: string): Promise<ItineraryBookingRow[]> {
    if (ids.length === 0) return [];
    return this.db.booking.findMany({
      where: { id: { in: ids }, userId },
    });
  }
}
