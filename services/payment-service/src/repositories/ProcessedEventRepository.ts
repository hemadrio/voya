/**
 * ProcessedEventRepository — durable exactly-once authority for Stripe
 * webhook idempotency (BR-03).
 *
 * The `processed_events` table has a UNIQUE constraint on (provider, event_id).
 * Attempting to insert a duplicate raises PostgreSQL error code 23505
 * (unique_violation).  This repository interprets that error as a "duplicate"
 * result so the webhook handler can safely skip re-processing.
 *
 * Injectable: depends only on a duck-typed PrismaClient slice so tests can
 * pass a simple object without instantiating the real Prisma client.
 */

// ---------------------------------------------------------------------------
// Injectable DB interface
// ---------------------------------------------------------------------------

export interface ProcessedEventData {
  provider: string;
  eventId: string;
  receivedAt: Date;
}

/** Minimal Prisma-compatible client slice for processed_events. */
export interface ProcessedEventDbClient {
  processedEvent: {
    create(args: { data: ProcessedEventData }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Repository result type
// ---------------------------------------------------------------------------

/** Outcome of an idempotency check-and-insert. */
export type InsertOutcome = "inserted" | "duplicate";

// ---------------------------------------------------------------------------
// PostgreSQL unique_violation error detection
// ---------------------------------------------------------------------------

/** PostgreSQL error code for unique constraint violation. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (err !== null && typeof err === "object") {
    // Prisma wraps PG errors under `.meta.code` or directly as `.code`
    const code = (err as Record<string, unknown>)["code"];
    return code === PG_UNIQUE_VIOLATION;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repository function
// ---------------------------------------------------------------------------

/**
 * Attempt to insert a processed-event record.
 *
 * Returns `"inserted"` when the row was successfully created (first delivery).
 * Returns `"duplicate"` when the unique constraint (provider, event_id) fires,
 * meaning this event has already been processed and the handler must skip it.
 *
 * Any other database error is re-thrown so the caller's error boundary handles
 * it (typically resulting in a 500 that tells Stripe to retry).
 */
export async function recordProcessedEvent(
  db: ProcessedEventDbClient,
  data: ProcessedEventData,
): Promise<InsertOutcome> {
  try {
    await db.processedEvent.create({ data });
    return "inserted";
  } catch (err) {
    if (isUniqueViolation(err)) {
      return "duplicate";
    }
    throw err;
  }
}
