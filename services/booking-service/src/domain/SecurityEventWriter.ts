/**
 * SecurityEventWriter — append-only security audit trail.
 *
 * Emits immutable records for every 403 and actor-context verification
 * failure.  The backing table has INSERT-only application grants (enforced
 * at the database layer by REVOKE UPDATE, DELETE and a trigger).
 *
 * Failure semantics: an unrecorded access-control decision is itself a
 * compliance failure.  Callers MUST NOT silently swallow write errors — if
 * write() throws, the calling operation should roll back and return 500.
 *
 * Injectable: depends only on duck-typed interfaces for testability.
 */

// ---------------------------------------------------------------------------
// Injectable persistence interface
// ---------------------------------------------------------------------------

export interface SecurityEventRow {
  id: string;
  actorId: string;
  actorRole: string;
  resourceType: string;
  resourceId?: string | null;
  operation: string;
  decision: string;
  reason?: string | null;
  occurredAt: Date;
}

export interface SecurityEventPrismaClient {
  securityEvent: {
    create(args: {
      data: {
        actorId: string;
        actorRole: string;
        resourceType: string;
        resourceId?: string | null;
        operation: string;
        decision: string;
        reason?: string | null;
        occurredAt?: Date;
      };
    }): Promise<SecurityEventRow>;
  };
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface SecurityEventInput {
  actorId: string;
  actorRole: string;
  resourceType: string;
  resourceId?: string;
  operation: string;
  decision: 'ALLOW' | 'DENY';
  reason?: string;
}

// ---------------------------------------------------------------------------
// SecurityEventWriter
// ---------------------------------------------------------------------------

export class SecurityEventWriter {
  constructor(private readonly db: SecurityEventPrismaClient) {}

  /**
   * Write an immutable security event.
   *
   * Throws on database failure — callers must NOT catch this silently.
   * An unrecorded access-control decision is a compliance failure.
   */
  async write(event: SecurityEventInput): Promise<void> {
    await this.db.securityEvent.create({
      data: {
        actorId: event.actorId,
        actorRole: event.actorRole,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        operation: event.operation,
        decision: event.decision,
        reason: event.reason ?? null,
        occurredAt: new Date(),
      },
    });
  }
}
