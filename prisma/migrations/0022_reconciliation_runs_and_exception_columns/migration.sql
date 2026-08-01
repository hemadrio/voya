-- Migration: 0022_reconciliation_runs_and_exception_columns
-- WO-050: Daily payment-to-booking reconciliation job.
--
-- Changes:
--   1. Extend reconciliation_exceptions with amount columns, provider_reference,
--      and period_date required by the daily reconciliation report.
--   2. Add a UNIQUE constraint on (kind, provider_reference, period_date) so
--      re-running the job for the same date is idempotent (AC3, AC6).
--   3. Add the reconciliation_runs table for cursor persistence and run
--      status tracking (AC1, AC9).
--
-- All DDL is idempotent (IF NOT EXISTS / IF NOT EXISTS columns).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Extend reconciliation_exceptions
-- ---------------------------------------------------------------------------

ALTER TABLE reconciliation_exceptions
  ADD COLUMN IF NOT EXISTS expected_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS actual_amount_minor   BIGINT,
  ADD COLUMN IF NOT EXISTS provider_reference    TEXT,
  ADD COLUMN IF NOT EXISTS period_date           DATE;

COMMENT ON COLUMN reconciliation_exceptions.expected_amount_minor IS
  'Expected settlement amount in integer minor units (e.g. cents). '
  'NULL when the exception does not involve an amount comparison.';

COMMENT ON COLUMN reconciliation_exceptions.actual_amount_minor IS
  'Actual settlement amount in integer minor units as reported by the provider. '
  'NULL when the exception does not involve an amount comparison.';

COMMENT ON COLUMN reconciliation_exceptions.provider_reference IS
  'Stripe charge, PaymentIntent, or refund ID that identifies the transaction '
  'on the provider side (used for triage lookups in the Stripe Dashboard).';

COMMENT ON COLUMN reconciliation_exceptions.period_date IS
  'UTC calendar date of the reconciliation run that produced this exception '
  '(YYYY-MM-DD). Used with kind and provider_reference to prevent duplicates.';

-- Unique constraint on (kind, provider_reference, period_date) — enforces
-- idempotency for re-runs: a second reconciliation of the same day cannot
-- produce a second row for the same exception.
-- NULL provider_reference is excluded from the constraint (NULLS are
-- distinct in Postgres UNIQUE, so WO-043 CONFIRMATION_AFTER_TERMINAL rows
-- with no provider_reference remain unconstrained by this index).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_reconciliation_exception_kind_ref_period'
  ) THEN
    CREATE UNIQUE INDEX uq_reconciliation_exception_kind_ref_period
      ON reconciliation_exceptions (kind, provider_reference, period_date)
      WHERE provider_reference IS NOT NULL AND period_date IS NOT NULL;
    -- Note: Postgres unique indexes enforce uniqueness the same as UNIQUE constraints.
    -- Using CREATE UNIQUE INDEX (not ALTER TABLE ADD CONSTRAINT) avoids IF NOT EXISTS
    -- limitations on CONSTRAINT syntax in older Postgres versions.
  END IF;
END $$;

-- Index on period_date for the daily reconciliation query
CREATE INDEX IF NOT EXISTS idx_reconciliation_period_date
  ON reconciliation_exceptions (period_date DESC)
  WHERE period_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. reconciliation_runs — cursor state + run metadata (AC1, AC9)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- UTC date for which this run was executed (UNIQUE — one run per day)
  period_date           DATE        NOT NULL,
  -- RUNNING | COMPLETED | FAILED | PARTIAL
  status                VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
  -- Stripe balance_transactions list cursor for resumability
  cursor                TEXT,
  -- Running count of provider transactions compared this run
  transactions_compared INTEGER     NOT NULL DEFAULT 0,
  -- Count of exceptions persisted this run
  exception_count       INTEGER     NOT NULL DEFAULT 0,
  -- Clean-run flag (true when exception_count = 0 after COMPLETED)
  clean_run             BOOLEAN     NOT NULL DEFAULT false,
  -- Correct-terminal-state percentage × 100 (e.g. 9985 = 99.85%)
  -- Stored as integer to avoid float representation issues.
  correct_terminal_pct  INTEGER,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  -- S3 key for the JSON report artifact
  report_s3_key         TEXT,

  CONSTRAINT uq_reconciliation_runs_period UNIQUE (period_date)
);

COMMENT ON TABLE reconciliation_runs IS
  'One row per reconciliation job execution. Stores the Stripe pagination '
  'cursor so a crashed run can resume. period_date is UNIQUE so re-running '
  'the job for the same date updates the existing row rather than inserting a '
  'new one (idempotency gate — WO-050 AC6).';

COMMENT ON COLUMN reconciliation_runs.clean_run IS
  'True when the run completed with zero exceptions. Used by the '
  'fourteen-consecutive-clean-days phase gate (AC9).';

COMMENT ON COLUMN reconciliation_runs.correct_terminal_pct IS
  'Correct-terminal-state percentage stored as integer basis points × 100. '
  'E.g. 9985 = 99.85 %. Computed as: '
  '(confirmed_with_settlement / total_settled_charges) * 10000. '
  'NULL until the run reaches COMPLETED status.';

-- Index on (period_date DESC) for the consecutive-clean-day gate query
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_period_desc
  ON reconciliation_runs (period_date DESC);

-- Index for status lookups (find RUNNING rows for crash recovery)
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status
  ON reconciliation_runs (status)
  WHERE status = 'RUNNING';

-- ---------------------------------------------------------------------------
-- Role grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- booking_service reads/writes reconciliation_runs and reconciliation_exceptions
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'booking_service') THEN
    GRANT SELECT, INSERT, UPDATE ON reconciliation_runs TO booking_service;
    -- reconciliation_exceptions already has booking_service grants from 0017;
    -- grant UPDATE for the resolved_at column (triage workflow)
    GRANT UPDATE ON reconciliation_exceptions TO booking_service;
  END IF;

  -- support_agent: read-only access to reconciliation data for triage
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_agent') THEN
    GRANT SELECT ON reconciliation_runs TO support_agent;
    GRANT SELECT ON reconciliation_exceptions TO support_agent;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reconciliation_exceptions'
      AND column_name = 'period_date'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: reconciliation_exceptions.period_date not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'reconciliation_runs'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: reconciliation_runs table not found';
  END IF;

  RAISE NOTICE 'ASSERTION PASSED: migration 0022 complete';
END $$;
