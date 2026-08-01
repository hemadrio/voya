-- Migration: 0015_legal_hold_purge_after_backfill
-- WO-102: Data Classification Tagging and Automated Retention Purge
--
-- Adds legal_hold column to bookings and booking_travelers so the purge
-- worker can skip rows that are under dispute or legal investigation.
-- Backfills purge_after for bookings rows whose purge_after is null
-- (rows written before WO-074 / migration 0005 set the column).
-- Adds skipped_legal_hold column to purge_runs for metric evidence.
--
-- Expand/contract strategy: every change is additive.
--   - legal_hold is nullable→boolean with default false (backward-safe)
--   - purge_runs.skipped_legal_hold is nullable → no breaking change
--   - backfill runs in a single batched UPDATE; runs read-committed

-- ---------------------------------------------------------------------------
-- 1. Add legal_hold to bookings
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

-- Partial index: only rows under legal hold (typically a very small set)
CREATE INDEX IF NOT EXISTS idx_bookings_legal_hold
  ON bookings (legal_hold)
  WHERE legal_hold = true;

-- ---------------------------------------------------------------------------
-- 2. Add legal_hold to booking_travelers
-- ---------------------------------------------------------------------------

ALTER TABLE booking_travelers
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_booking_travelers_legal_hold
  ON booking_travelers (legal_hold)
  WHERE legal_hold = true;

-- ---------------------------------------------------------------------------
-- 3. Backfill purge_after for bookings rows missing it
--
-- purge_after = created_at + RETENTION_TRANSACTION_YEARS years
-- RETENTION_TRANSACTION_YEARS is ASSUMPTION (7 years) — value injected via
-- env at runtime by the purge worker.  For the backfill we use 7 years as a
-- safe lower bound.  The retention worker's nightly recompute will correct
-- any rows if the sponsor-ratified value differs.
-- ---------------------------------------------------------------------------

UPDATE bookings
SET    purge_after = created_at + INTERVAL '7 years'
WHERE  purge_after IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Backfill purge_after for sessions rows missing it
--
-- purge_after = expires_at + RETENTION_SESSION_DAYS days (7 days assumed)
-- ---------------------------------------------------------------------------

UPDATE sessions
SET    purge_after = expires_at + INTERVAL '7 days'
WHERE  purge_after IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Backfill purge_after for one_time_tokens rows missing it
-- ---------------------------------------------------------------------------

UPDATE one_time_tokens
SET    purge_after = expires_at + INTERVAL '7 days'
WHERE  purge_after IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Backfill purge_after for itineraries rows missing it
-- ---------------------------------------------------------------------------

UPDATE itineraries
SET    purge_after = created_at + INTERVAL '7 years'
WHERE  purge_after IS NULL;

-- ---------------------------------------------------------------------------
-- 7. Backfill purge_after for travel_preferences rows missing it
--
-- purge_after = updated_at + RETENTION_PREFERENCE_DAYS days (365 days assumed)
-- ---------------------------------------------------------------------------

UPDATE travel_preferences
SET    purge_after = updated_at + INTERVAL '365 days'
WHERE  purge_after IS NULL;

-- ---------------------------------------------------------------------------
-- 8. Add skipped_legal_hold counter to purge_runs for metric evidence
-- ---------------------------------------------------------------------------

ALTER TABLE purge_runs
  ADD COLUMN IF NOT EXISTS skipped_legal_hold BIGINT NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 9. Grant UPDATE (legal_hold) on bookings and booking_travelers to
--    purge_worker so it can set legal_hold=false after a hold is lifted
--    via the compliance operations path.
--    Grant SELECT on the new column (SELECT * already granted; explicit
--    column SELECT not required when table-level SELECT is held).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  GRANT UPDATE (legal_hold) ON TABLE bookings          TO purge_worker;
  GRANT UPDATE (legal_hold) ON TABLE booking_travelers TO purge_worker;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'purge_worker role not found — skipping GRANT';
END $$;
