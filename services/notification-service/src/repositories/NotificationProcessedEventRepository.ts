/**
 * Repository for the notification_processed_events table.
 *
 * The insert is the durable authority for exactly-once delivery.  A P2002
 * unique-violation on (provider, event_id) means the event was already
 * processed; callers treat this as a successful duplicate suppression.
 */

import { TransientDbError } from '../domain/backoff.js';

export interface ProcessedEventRecord {
  readonly provider: string;
  readonly eventId: string;
  readonly handler: string;
  readonly correlationId: string;
}

// Minimal Prisma client interface — avoids importing @prisma/client in tests.
export interface NotificationPrismaClient {
  notificationProcessedEvent: {
    create(args: {
      data: {
        provider: string;
        eventId: string;
        handler: string;
        correlationId: string;
      };
    }): Promise<unknown>;
  };
}

export class NotificationProcessedEventRepository {
  constructor(private readonly db: NotificationPrismaClient) {}

  /**
   * Insert a processed_event row.
   *
   * @returns true if inserted (first delivery), false if duplicate (P2002).
   * @throws TransientDbError on Prisma connection errors (P1001, P1017).
   */
  async insert(record: ProcessedEventRecord): Promise<boolean> {
    try {
      await this.db.notificationProcessedEvent.create({
        data: {
          provider: record.provider,
          eventId: record.eventId,
          handler: record.handler,
          correlationId: record.correlationId,
        },
      });
      return true;
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        return false;
      }
      if (isPrismaConnectionError(err)) {
        throw new TransientDbError(
          `Database connection error while inserting processed_event: ${errorMessage(err)}`,
        );
      }
      throw err;
    }
  }
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as Record<string, unknown>)['code'] === 'P2002'
  );
}

function isPrismaConnectionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as Record<string, unknown>)['code'];
  return code === 'P1001' || code === 'P1017';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
