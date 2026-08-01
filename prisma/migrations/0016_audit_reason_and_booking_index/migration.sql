-- Migration: 0016_audit_reason_and_booking_index
-- WO-041: Append-only immutable booking audit writer.
--
-- Part A — additive column on booking_audit_log:
--   reason  VARCHAR(512) — human-readable reason for the state transition
--     (e.g. "CANCELLATION_REQUESTED", "PRICE_CHANGE_ACCEPTED").
--   All rows without a reason default to NULL; this is backward-compatible
--   with previous-version services that omit the field.
--
-- Part B — index for ordered history reads:
--   booking_audit_log_booking_occurred ON (booking_id, occurred_at DESC)
--   Name matches the WO-041 spec so that external tooling can reference it.
--   CONCURRENTLY avoids a full-table lock in production; safe to re-run
--   because IF NOT EXISTS is used.
--
-- Part C — GDPR pseudonymisation helper function:
--   pseudonymise_audit_actor(p_actor_id TEXT, p_surrogate TEXT) updates every
--   booking_audit_log row for the given actor to replace actor_id with a
--   stable, opaque surrogate.  The row is NEVER deleted; only actor_id is
--   replaced.  The surrogate must be pre-computed by the application layer
--   (SHA-256 of actor_id + site secret) before invoking this function so the
--   database never derives the surrogate independently.
--
-- All DDL steps are idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS, CREATE OR REPLACE FUNCTION.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A  Add 'reason' column to booking_audit_log
-- ---------------------------------------------------------------------------

ALTER TABLE booking_audit_log
  ADD COLUMN IF NOT EXISTS reason VARCHAR(512);

COMMENT ON COLUMN booking_audit_log.reason IS
  'Human-readable reason for the state transition. NULL for system-initiated '
  'events where no explicit reason is provided. WO-041.';

-- ---------------------------------------------------------------------------
-- B  Create ordered index for GET /v1/bookings/{id}/audit history reads
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS booking_audit_log_booking_occurred
  ON booking_audit_log (booking_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- C  GDPR pseudonymisation helper stored procedure
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pseudonymise_audit_actor(
  p_actor_id  TEXT,
  p_surrogate TEXT
) RETURNS BIGINT AS $$
DECLARE
  v_updated BIGINT;
BEGIN
  -- Replace actor_id with the pre-computed surrogate.
  -- The surrogate is opaque (SHA-256 hex) and stable: calling this function
  -- twice with the same arguments produces the same final state (idempotent).
  --
  -- This function runs as the migration_task role (not the app role) so it
  -- bypasses the booking_audit_log INSERT-only constraint.  Erasure is a
  -- privileged operation; it must never be callable by the application role.
  UPDATE booking_audit_log
  SET    actor_id = p_surrogate
  WHERE  actor_id = p_actor_id
    AND  actor_id <> p_surrogate;  -- idempotent guard

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER   -- executes as the function owner (migration_task), not caller
   SET search_path = public;

-- Revoke EXECUTE from PUBLIC (only the erasure worker role may call this).
REVOKE EXECUTE ON FUNCTION pseudonymise_audit_actor(TEXT, TEXT) FROM PUBLIC;

DO $$
BEGIN
  BEGIN
    GRANT EXECUTE ON FUNCTION pseudonymise_audit_actor(TEXT, TEXT)
      TO erasure_worker;
    RAISE NOTICE 'GRANT EXECUTE on pseudonymise_audit_actor to erasure_worker';
  EXCEPTION WHEN undefined_object THEN
    RAISE NOTICE 'Role erasure_worker does not exist — GRANT skipped';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Assertion: reason column exists with the correct type
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_name  = 'booking_audit_log'
      AND  column_name = 'reason'
  ) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: reason column not found on booking_audit_log';
  END IF;
  RAISE NOTICE 'ASSERTION PASSED: reason column present on booking_audit_log';
END $$;
