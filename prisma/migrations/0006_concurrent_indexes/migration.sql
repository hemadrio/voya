-- Migration: 0006_concurrent_indexes
-- WO-077: Index tuning — add purpose-built indexes for real query predicates.
--
-- !! THIS MIGRATION MUST BE EXECUTED OUTSIDE A POSTGRESQL TRANSACTION !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- Run with: prisma migrate deploy --no-transaction
-- Or as a standalone psql invocation: psql $DATABASE_URL -f migration.sql
--
-- All CREATE INDEX statements use IF NOT EXISTS and CONCURRENTLY so:
--   1. The migration is idempotent when re-run.
--   2. No ACCESS EXCLUSIVE lock is taken on a populated table.
--   3. An INVALID index left by a failed previous build is detected and
--      dropped before the build retries.
--
-- Target queries (observed predicates — no speculative indexes added):
--   Q1  booking history list : SELECT * FROM bookings WHERE user_id=$1 ORDER BY created_at DESC
--   Q2  ownership read       : SELECT * FROM bookings WHERE id=$1 AND user_id=$2
--   Q3  pending expiry sweep : SELECT id FROM bookings WHERE status='PENDING' AND expires_at < now()
--   Q4  session token lookup : SELECT * FROM sessions WHERE refresh_token_hash=$1
--   Q5  session expiry sweep : SELECT id FROM sessions WHERE expires_at < now()
--   Q6  audit by booking     : SELECT * FROM booking_audit_log WHERE resource_id=$1 ORDER BY occurred_at
--                              (index idx_audit_resource_occurred already present from WO-072)
--   Q7  processed-event dedup: SELECT 1 FROM processed_events WHERE provider=$1 AND event_id=$2
--                              (uq_processed_events_provider_event already present from WO-072)
--   Q8  purge candidate sweep: SELECT id FROM <table> WHERE purge_after < now()
--                              (purge_after indexes already present from WO-074)
--
-- ---------------------------------------------------------------------------
-- Helper: drop an INVALID index if it exists from a previously failed build
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT indexrelid::regclass::text AS idx_name
    FROM   pg_index
    WHERE  indisvalid = false
      AND  indexrelid::regclass::text IN (
        'idx_bookings_user_created_at',
        'idx_bookings_ownership',
        'idx_bookings_pending_expiry',
        'uq_sessions_refresh_token_hash',
        'idx_sessions_expires_at'
      )
  LOOP
    RAISE NOTICE 'Dropping INVALID index: %', idx.idx_name;
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS %I', idx.idx_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Schema additions: expires_at on bookings
-- (additive, nullable — previous-version services write NULL automatically)
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Q1: booking history — (user_id, created_at DESC)
-- Enables ORDER BY created_at DESC without a sort step for a given user.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_user_created_at
  ON bookings (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Q2: ownership read — (id, user_id)
-- Supports WHERE id=$1 AND user_id=$2 as an index-only check for the
-- deny-by-default access control pattern (confirm ownership via index).
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_ownership
  ON bookings (id, user_id);

-- ---------------------------------------------------------------------------
-- Q3: pending-booking expiry sweep — partial (status, expires_at)
-- Only PENDING bookings are eligible for the expiry sweep, so this partial
-- index covers the full predicate and is far smaller than a full-table index.
-- The index column order (status first) is redundant since it is constant in
-- the WHERE clause, but it makes the index self-documenting.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_pending_expiry
  ON bookings (status, expires_at)
  WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Q4: session lookup by refresh token hash — unique partial
-- refresh_token_hash is nullable (old rows pre-WO-024 have no hash) so we use
-- a partial UNIQUE index scoped to non-NULL rows only, which Postgres treats
-- as a safe unique constraint while ignoring legacy rows.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sessions_refresh_token_hash
  ON sessions (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Q5: session expiry sweep — (expires_at)
-- Auth-service purges expired sessions; this scan is currently sequential.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_expires_at
  ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Backfill expires_at for existing PENDING bookings
-- (created_at + 30 minutes — the pending-booking timeout window)
-- Only updates rows where status is still PENDING and expires_at is not set.
-- ---------------------------------------------------------------------------

UPDATE bookings
   SET expires_at = created_at + INTERVAL '30 minutes'
 WHERE status     = 'PENDING'
   AND expires_at IS NULL;
