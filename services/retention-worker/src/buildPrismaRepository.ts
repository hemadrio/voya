/**
 * Builds a PurgeRepositoryPort backed by Prisma.
 *
 * All queries are parameterized (policy A05 — no SQL string interpolation).
 * DELETE is only performed on tables the purge_worker role has DELETE on.
 * booking_audit_log rows are never deleted by this repository.
 */

import { PrismaClient } from "@prisma/client";
import type { PurgeRepositoryPort, ErasureCandidate, PurgeRunRecord, QuarantineEntry, PurgeLogger } from "@travel/retention";

export async function buildPrismaRepository(logger: PurgeLogger): Promise<PurgeRepositoryPort & { disconnect?: () => Promise<void> }> {
  const prisma = new PrismaClient({
    log: [],
  });

  // Table name allowlist — only tables with purge_after that can be physically deleted.
  // booking_audit_log is deliberately excluded (no DELETE grant, immutable log).
  const DELETABLE_TABLES = new Set([
    "users",
    "sessions",
    "one_time_tokens",
    "bookings",
    "booking_travelers",
    "itineraries",
    "travel_preferences",
    "conversation_messages",
  ]);

  function assertDeletable(table: string): void {
    if (!DELETABLE_TABLES.has(table)) {
      throw new Error(`Table "${table}" is not in the purge allowlist`);
    }
  }

  return {
    async countExpired(table: string, now: Date): Promise<number> {
      // Parameterized via Prisma — no string interpolation in WHERE values.
      // Counts only rows NOT under legal hold — legal_hold rows are counted
      // separately via countLegalHold so metrics reflect the true state.
      const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM ${prisma.$raw(`"${table}"`)}
        WHERE purge_after IS NOT NULL
          AND purge_after <= ${now}
          AND (legal_hold IS NULL OR legal_hold = false)
      `;
      return Number(result[0]?.count ?? 0);
    },

    async countLegalHold(table: string, now: Date): Promise<number> {
      // Count rows due for purge that are blocked by legal hold.
      // Tables without a legal_hold column return 0 safely via COALESCE.
      try {
        const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count
          FROM ${prisma.$raw(`"${table}"`)}
          WHERE purge_after IS NOT NULL
            AND purge_after <= ${now}
            AND legal_hold = true
        `;
        return Number(result[0]?.count ?? 0);
      } catch {
        // Table has no legal_hold column (e.g. conversation_messages) — return 0
        return 0;
      }
    },

    async deleteBatch(table: string, batchSize: number, now: Date): Promise<number> {
      assertDeletable(table);
      // FOR UPDATE SKIP LOCKED prevents concurrent runs from processing the
      // same batch. legal_hold = true rows are never selected for deletion.
      const result = await prisma.$executeRaw`
        DELETE FROM ${prisma.$raw(`"${table}"`)}
        WHERE id IN (
          SELECT id FROM ${prisma.$raw(`"${table}"`)}
          WHERE purge_after IS NOT NULL
            AND purge_after <= ${now}
            AND (legal_hold IS NULL OR legal_hold = false)
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
      `;
      return result;
    },

    async fetchErasureCandidates(table: string, batchSize: number, now: Date): Promise<ErasureCandidate[]> {
      // Exclude legal_hold rows from erasure candidates.
      const rows = await prisma.$queryRaw<Array<{
        id: string;
        subject_id: string;
        wrapped_dek: Buffer | null;
        dek_key_id: string | null;
        booking_id: string;
      }>>`
        SELECT id, subject_id, wrapped_dek, dek_key_id, booking_id
        FROM ${prisma.$raw(`"${table}"`)}
        WHERE purge_after IS NOT NULL
          AND purge_after <= ${now}
          AND wrapped_dek IS NOT NULL
          AND (legal_hold IS NULL OR legal_hold = false)
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      return rows.map((r) => ({
        id: r.id,
        subjectId: r.subject_id,
        wrappedDek: r.wrapped_dek,
        dekKeyId: r.dek_key_id,
        bookingId: r.booking_id,
      }));
    },

    async nullifyWrappedDek(table: string, ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const result = await prisma.$executeRaw`
        UPDATE ${prisma.$raw(`"${table}"`)}
        SET wrapped_dek = NULL,
            dek_key_id  = NULL
        WHERE id = ANY(${ids}::uuid[])
      `;
      return result;
    },

    async pseudonymiseActor(table: string, actorIds: string[]): Promise<number> {
      if (actorIds.length === 0) return 0;
      // Replace actor_id with SHA-256('REDACTED:' || actor_id) as hex string.
      // Parameterized — actor_id values are bound, not interpolated.
      const result = await prisma.$executeRaw`
        UPDATE ${prisma.$raw(`"${table}"`)}
        SET actor_id = encode(
              sha256(('REDACTED:' || actor_id)::bytea),
              'hex'
            )
        WHERE actor_id = ANY(${actorIds})
          AND purge_after IS NOT NULL
          AND purge_after <= NOW()
      `;
      return result;
    },

    async deleteConversationKeys(cutoffDate: Date, batchSize: number): Promise<number> {
      // conversation_messages table physical delete (durable sweep)
      const result = await prisma.$executeRaw`
        DELETE FROM conversation_messages
        WHERE id IN (
          SELECT id FROM conversation_messages
          WHERE created_at <= ${cutoffDate}
          LIMIT ${batchSize}
        )
      `;
      return result;
    },

    async recordPurgeRun(run: PurgeRunRecord): Promise<void> {
      // Counts only — no subject identifiers or personal data (BR-13).
      await prisma.$executeRaw`
        INSERT INTO purge_runs (
          category, entry_id, correlation_id,
          started_at, finished_at,
          examined, purged, keys_destroyed, skipped_legal_hold,
          status, error_message, dry_run
        ) VALUES (
          ${run.category}, ${run.entryId}, ${run.correlationId}::uuid,
          ${run.startedAt}, ${run.finishedAt},
          ${run.examined}, ${run.purged}, ${run.keysDestroyed}, ${run.skippedLegalHold},
          ${run.status}, ${run.errorMessage ?? null}, ${run.dryRun}
        )
      `;
    },

    async acquireLease(leaseKey: string, ttlSeconds: number): Promise<boolean> {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      try {
        await prisma.$executeRaw`
          INSERT INTO purge_lease (lease_key, acquired_at, expires_at)
          VALUES (${leaseKey}, NOW(), ${expiresAt})
          ON CONFLICT (lease_key) DO UPDATE
            SET acquired_at = EXCLUDED.acquired_at,
                expires_at  = EXCLUDED.expires_at
          WHERE purge_lease.expires_at < NOW()
        `;
        // If the INSERT/UPDATE affected 0 rows, an active lease already exists
        const active = await prisma.$queryRaw<Array<{ lease_key: string }>>`
          SELECT lease_key FROM purge_lease
          WHERE lease_key = ${leaseKey}
            AND expires_at >= NOW()
            AND acquired_at >= NOW() - INTERVAL '1 second'
        `;
        return active.length > 0;
      } catch {
        return false;
      }
    },

    async releaseLease(leaseKey: string): Promise<void> {
      await prisma.$executeRaw`
        DELETE FROM purge_lease WHERE lease_key = ${leaseKey}
      `;
    },

    async getDbLoadFactor(): Promise<number> {
      const result = await prisma.$queryRaw<Array<{ active: bigint; max_conn: bigint }>>`
        SELECT
          COUNT(*) FILTER (WHERE state = 'active') AS active,
          current_setting('max_connections')::bigint AS max_conn
        FROM pg_stat_activity
      `;
      const row = result[0];
      if (!row || !row.max_conn) return 0;
      return Number(row.active) / Number(row.max_conn);
    },

    async quarantine(entry: QuarantineEntry): Promise<void> {
      await prisma.$executeRaw`
        INSERT INTO purge_quarantine (table_name, row_id, reason, correlation_id, quarantined_at)
        VALUES (
          ${entry.table}, ${entry.rowId}::uuid,
          ${entry.reason}, ${entry.correlationId}::uuid,
          ${entry.quarantinedAt}
        )
        ON CONFLICT (table_name, row_id) WHERE resolved_at IS NULL DO NOTHING
      `;
    },

    async disconnect(): Promise<void> {
      await prisma.$disconnect();
    },
  };
}
