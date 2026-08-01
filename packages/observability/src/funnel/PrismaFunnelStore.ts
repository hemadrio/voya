/**
 * PrismaFunnelStore — append-only RDS adapter for funnel events (WO-106 AC5).
 *
 * The application role has INSERT and SELECT only; no UPDATE or DELETE.
 * purge_after is computed at insert time: now + retentionDays (default 400 days).
 *
 * This adapter is thin: it marshals FunnelEvent objects to Prisma-compatible
 * row shapes and delegates all persistence to an injected Prisma-like client.
 * No direct Prisma import lives in the observability package.
 */

import type { FunnelEvent } from "@travel/contracts";
import type { FunnelStorePort } from "./funnelEmitter.js";

// ---------------------------------------------------------------------------
// Minimal duck-typed Prisma client interface
// ---------------------------------------------------------------------------

export interface FunnelEventCreateInput {
  id?: string;
  schemaVersion: number;
  eventType: string;
  occurredAt: Date;
  correlationId: string;
  pseudonymousActorId: string;
  sessionId: string;
  conversationId?: string | null;
  itineraryId?: string | null;
  bookingId?: string | null;
  category: string;
  attributes: Record<string, unknown>;
  purgeAfter: Date;
}

export interface PrismaFunnelClient {
  funnel_event: {
    createMany(args: {
      data: FunnelEventCreateInput[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
  };
}

// ---------------------------------------------------------------------------
// PrismaFunnelStore
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 400;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export class PrismaFunnelStore implements FunnelStorePort {
  private readonly _db: PrismaFunnelClient;
  private readonly _retentionDays: number;
  private readonly _clock: () => Date;

  constructor(
    db: PrismaFunnelClient,
    opts: { retentionDays?: number; clock?: () => Date } = {},
  ) {
    this._db = db;
    this._retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this._clock = opts.clock ?? (() => new Date());
  }

  async insertBatch(events: FunnelEvent[]): Promise<void> {
    if (events.length === 0) return;

    const now = this._clock();
    const purgeAfter = new Date(now.getTime() + this._retentionDays * MS_PER_DAY);

    const rows: FunnelEventCreateInput[] = events.map((ev) => ({
      schemaVersion: ev.schemaVersion,
      eventType: ev.eventType,
      occurredAt: new Date(ev.occurredAt),
      correlationId: ev.correlationId,
      pseudonymousActorId: ev.pseudonymousActorId,
      sessionId: ev.sessionId,
      conversationId: ev.conversationId ?? null,
      itineraryId: ev.itineraryId ?? null,
      bookingId: ev.bookingId ?? null,
      category: ev.category,
      attributes: ev.attributes,
      purgeAfter,
    }));

    await this._db.funnel_event.createMany({ data: rows, skipDuplicates: false });
  }
}
