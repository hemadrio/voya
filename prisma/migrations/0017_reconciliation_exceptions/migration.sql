-- Migration: 0017_reconciliation_exceptions
-- WO-043: reconciliation_exceptions table for late-confirmation conflicts.
--
-- This table is shared with WO-050 (reconciliation report). We create it here
-- because WO-043 is the first consumer: the expiry sweep records a row when a
-- Stripe webhook confirmation arrives for a booking that is already EXPIRED.
--
-- Design:
--   kind            — classification of the anomaly (LATE_CONFIRMATION, etc.)
--   booking_id      — FK to bookings; NULL if the booking no longer exists.
--   payment_intent_id — Stripe PI reference, for joining to payments table.
--   detail          — JSONB free-form context (sanitised; no PII).
--   detected_at     — wall-clock when the exception was recorded.
--   resolved_at     — nullable; set by the ops team when triaged.
--
-- All DDL is idempotent (IF NOT EXISTS).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind                VARCHAR(64) NOT NULL,
  booking_id          UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  payment_intent_id   VARCHAR(255),
  detail              JSONB       NOT NULL DEFAULT '{}',
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

COMMENT ON TABLE reconciliation_exceptions IS
  'Anomalies detected during payment reconciliation or the expiry sweep. '
  'Shared by WO-043 (expiry) and WO-050 (reconciliation report). '
  'Rows are retained per the audit retention policy; never purged by the personal-data purge job.';

COMMENT ON COLUMN reconciliation_exceptions.kind IS
  'Classification: LATE_CONFIRMATION (webhook arrived after EXPIRED), '
  'DUPLICATE_CHARGE, AMOUNT_MISMATCH, etc.';

COMMENT ON COLUMN reconciliation_exceptions.detail IS
  'Sanitised JSONB context. Must never contain PII (no email, passport, card data).';

-- Index for ops lookups by booking
CREATE INDEX IF NOT EXISTS idx_reconciliation_booking
  ON reconciliation_exceptions (booking_id)
  WHERE booking_id IS NOT NULL;

-- Index for unresolved-exception queries used by WO-050 report
CREATE INDEX IF NOT EXISTS idx_reconciliation_unresolved
  ON reconciliation_exceptions (detected_at DESC)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Assertion: table exists
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'reconciliation_exceptions'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: reconciliation_exceptions table not found';
  END IF;
  RAISE NOTICE 'ASSERTION PASSED: reconciliation_exceptions table present';
END $$;
