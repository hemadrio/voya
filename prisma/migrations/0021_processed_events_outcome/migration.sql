-- Migration: 0021_processed_events_outcome
-- WO-047: Exactly-once webhook processing with durable event dedup
--
-- Adds the `outcome` column to processed_events so each record carries
-- the processing result (PROCESSED, IGNORED, EXCEPTION) alongside the
-- idempotency key.  The column is NOT NULL with default 'PROCESSED' for
-- backward compatibility with any existing rows written by the pre-WO-047
-- handler that did not record an outcome.
--
-- Also adds a partial index on outcome for fast EXCEPTION lookups by ops
-- and the reconciliation report.
--
-- All DDL is idempotent (IF NOT EXISTS / DO $$ guards).

-- ---------------------------------------------------------------------------
-- 1. Add outcome column (NOT NULL DEFAULT 'PROCESSED')
-- ---------------------------------------------------------------------------

ALTER TABLE processed_events
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(32) NOT NULL DEFAULT 'PROCESSED';

-- ---------------------------------------------------------------------------
-- 2. Partial index — fast lookup of EXCEPTION outcomes for ops / alerting
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_processed_events_exceptions
  ON processed_events (provider, outcome)
  WHERE outcome = 'EXCEPTION';

-- ---------------------------------------------------------------------------
-- 3. Role grants — booking_service needs to INSERT and SELECT
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  -- Grant to booking_service role if it exists (idempotent guard)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'booking_service') THEN
    GRANT SELECT, INSERT ON processed_events TO booking_service;
  END IF;
  -- Support agents may SELECT (for ops queries) but not INSERT
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_agent') THEN
    GRANT SELECT ON processed_events TO support_agent;
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;
