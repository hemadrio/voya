-- Migration: 0019_refund_constraints
-- WO-049: Refunds through original payment route with split records
--
-- Adds:
--   1. CHECK constraint requiring parent_payment_id on REFUND rows.
--   2. Composite index (parent_payment_id, type) for fast cumulative sum queries.
--   3. settlement_windows configuration table for legal-owned refund wording templates.
--
-- All statements are idempotent (IF NOT EXISTS / DO $$ ... END $$).

-- ---------------------------------------------------------------------------
-- 1. CHECK constraint: REFUND rows must have a non-null parent_payment_id
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'check_refund_parent_required'
      AND constraint_schema = 'public'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT check_refund_parent_required
      CHECK (type != 'REFUND' OR parent_payment_id IS NOT NULL);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Index: (parent_payment_id, type) for cumulative refund sum
--    Used by the SELECT FOR UPDATE path in RefundService.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payments_parent_type
  ON payments (parent_payment_id, type)
  WHERE parent_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. settlement_windows — configurable refund wording templates (WO-049 AC7)
--
--   Keyed by (provider, currency): e.g. ('stripe', 'USD').
--   Wording can be updated by ops without a deployment.
--   The SettlementWindowService reads this table at runtime (or falls back
--   to the built-in template map if this table is not populated).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settlement_windows (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     VARCHAR(32) NOT NULL,
  currency     CHAR(3)     NOT NULL,
  wording      TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT,

  CONSTRAINT uq_settlement_windows_provider_currency
    UNIQUE (provider, currency)
);

COMMENT ON TABLE settlement_windows IS
  'Configurable refund settlement-window wording templates keyed by (provider, currency). '
  'Managed by ops; consulted by SettlementWindowService at runtime. '
  'WO-049 AC7: wording changes here do not require a deployment.';

-- Seed the current default templates (from SettlementWindowService built-in map)
INSERT INTO settlement_windows (provider, currency, wording, updated_by)
VALUES
  ('stripe', 'USD', 'Refunds typically appear on your statement within 5–10 business days.', 'migration:0019'),
  ('stripe', 'EUR', 'Refunds are typically processed within 5–10 business days.', 'migration:0019'),
  ('stripe', 'GBP', 'Refunds are typically processed within 3–5 business days.', 'migration:0019')
ON CONFLICT (provider, currency) DO NOTHING;

COMMENT ON TABLE settlement_windows IS
  'Configurable refund settlement-window wording (WO-049). Legal team updates wording here; '
  'no deployment required. Pending Q9 legal sign-off.';
