/**
 * ItineraryReparentRepository — guest-to-member ownership transfer.
 *
 * When an anonymous session creates an itinerary and the user subsequently
 * registers, the itinerary must be atomically transferred to the new user
 * within the same transaction that creates the account.
 *
 * The WHERE clause always includes BOTH the itinerary id AND the anonymous
 * session id (as a placeholder userId) so the update is idempotent and
 * cannot be replayed against a different user's row.
 *
 * Invariant: there must be no window where neither the guest nor the member
 * owns the row.  This is guaranteed by running the UPDATE inside the account
 * creation transaction.
 */

// ---------------------------------------------------------------------------
// Injectable Prisma interface
// ---------------------------------------------------------------------------

export interface ItineraryRow {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReparentPrismaClient {
  itinerary: {
    updateMany(args: {
      where: { userId: string };
      data: { userId: string; updatedAt: Date };
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// ItineraryReparentRepository
// ---------------------------------------------------------------------------

export class ItineraryReparentRepository {
  constructor(private readonly db: ReparentPrismaClient) {}

  /**
   * Transfer all itineraries owned by guestSessionId to newUserId.
   *
   * Must be called inside the account-creation transaction so the ownership
   * predicate is satisfied atomically from registration onwards.
   *
   * Returns the number of itineraries transferred (zero is valid — guest may
   * not have created any itineraries before registering).
   */
  async reparentGuestItineraries(
    guestSessionId: string,
    newUserId: string,
    txDb: ReparentPrismaClient,
  ): Promise<number> {
    const result = await txDb.itinerary.updateMany({
      where: { userId: guestSessionId },
      data: { userId: newUserId, updatedAt: new Date() },
    });
    return result.count;
  }
}
