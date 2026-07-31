/**
 * Two-layer idempotency guard.
 *
 * Layer 1 (hot path): Redis SET NX with a 72-hour TTL.
 *   Fast O(1) check; prevents database writes on repeated delivery during
 *   the normal operating window.
 *
 * Layer 2 (durable authority): INSERT into notification_processed_events,
 *   catching the P2002 unique-violation as a successful duplicate signal.
 *   A Redis outage falls through to this layer — the system degrades to
 *   slower but still exactly-once operation.
 *
 * Both layers must agree: the DB constraint is the authority. If Redis says
 * "new" but the DB says "duplicate" the event is treated as a duplicate and
 * acked without sending.
 */

import type { NotificationProcessedEventRepository } from '../repositories/NotificationProcessedEventRepository.js';

// 72 hours in seconds
const REDIS_TTL_SECONDS = 72 * 60 * 60;

export type GuardResult = 'new' | 'duplicate';

// Minimal Redis interface (ioredis duck-typed).
export interface RedisClient {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    time: number,
    setMode: 'NX',
  ): Promise<'OK' | null>;
}

export class IdempotencyGuard {
  constructor(
    private readonly redis: RedisClient | null,
    private readonly repo: NotificationProcessedEventRepository,
  ) {}

  /**
   * Attempt to claim the event ID as processed.
   *
   * @returns 'duplicate' if the event was already processed; 'new' if this
   *   is the first delivery and the processed_event row was inserted.
   *
   * The DB insert happens inside this call. The caller must dispatch the SES
   * send AFTER this returns 'new' so that a crash between insert and send
   * leaves the row committed; on redelivery the DB returns 'duplicate' and
   * no second email is sent.
   */
  async claim(opts: {
    provider: string;
    eventId: string;
    handler: string;
    correlationId: string;
  }): Promise<GuardResult> {
    const redisKey = `notification:processed:${opts.provider}:${opts.eventId}`;

    // Layer 1: Redis SET NX (best-effort fast path)
    if (this.redis !== null) {
      try {
        const result = await this.redis.set(
          redisKey,
          '1',
          'EX',
          REDIS_TTL_SECONDS,
          'NX',
        );
        if (result === null) {
          // Redis already has the key → duplicate
          return 'duplicate';
        }
        // Redis said new → fall through to DB insert to confirm durably
      } catch {
        // Redis unavailable — degrade to DB-only path without propagating.
        // A Redis outage must never drop or duplicate messages; the DB
        // constraint is the durable authority.
      }
    }

    // Layer 2: DB insert (durable authority)
    const inserted = await this.repo.insert({
      provider: opts.provider,
      eventId: opts.eventId,
      handler: opts.handler,
      correlationId: opts.correlationId,
    });

    return inserted ? 'new' : 'duplicate';
  }
}
