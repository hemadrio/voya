-- Migration: 0001_initial_booking_audit_provenance
-- Strategy: expand/contract — all changes are additive.
-- All DDL statements are guarded with IF NOT EXISTS / IF EXISTS or wrapped
-- in DO blocks so this migration is idempotent when re-run by a retried
-- ECS migration task.
--
-- Execution order (run by the one-off ECS migration task before service rollout):
--   1. Base tables (users, sessions, bookings, booking_audit_log)
--   2. Additive column additions to existing tables
--   3. Append-only trigger + REVOKE + per-role GRANTs for booking_audit_log
--   4. processed_events table with unique constraint
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1a. Table: users (prerequisite for bookings FK)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'traveler',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users(id),
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1b. Table: bookings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id                     UUID           NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                UUID           NOT NULL REFERENCES users(id),
  booking_type           TEXT           NOT NULL,
  status                 TEXT           NOT NULL DEFAULT 'PENDING',
  offer_id               TEXT           NOT NULL,
  total_price            DECIMAL(12, 2) NOT NULL,
  currency               CHAR(3)        NOT NULL,
  contact_email          TEXT           NOT NULL,
  contact_phone          TEXT,
  idempotency_key        TEXT           NOT NULL UNIQUE,
  search_result_snapshot JSON,
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- WO-072 additive columns on bookings (idempotent via IF NOT EXISTS)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS provenance VARCHAR(64),
  ADD COLUMN IF NOT EXISTS bookable   BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);

-- ---------------------------------------------------------------------------
-- 1c. Table: booking_audit_log (append-only enforcement below)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_audit_log (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id     UUID        NOT NULL REFERENCES bookings(id),
  action         TEXT        NOT NULL,
  previous_state JSONB,
  new_state      JSONB,
  changed_by     TEXT,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WO-072 additive columns (idempotent)
ALTER TABLE booking_audit_log
  ADD COLUMN IF NOT EXISTS actor_id      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS actor_role    VARCHAR(32),
  ADD COLUMN IF NOT EXISTS resource_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS resource_id   VARCHAR(128),
  ADD COLUMN IF NOT EXISTS occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Monotonically ordered identity column (BIGSERIAL equivalent via GENERATED ALWAYS).
-- Wrapped in a DO block for idempotency — ADD COLUMN IF NOT EXISTS does not
-- support GENERATED ALWAYS AS IDENTITY in PostgreSQL < 16.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name  = 'booking_audit_log'
    AND    column_name = 'sequence'
    AND    table_schema = current_schema()
  ) THEN
    ALTER TABLE booking_audit_log
      ADD COLUMN sequence BIGINT GENERATED ALWAYS AS IDENTITY;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_resource_occurred
  ON booking_audit_log(resource_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 2. Append-only enforcement for booking_audit_log
-- ---------------------------------------------------------------------------

-- Trigger function — raises an exception on any UPDATE or DELETE attempt.
-- SECURITY DEFINER so the check runs as the function owner, not the caller.
CREATE OR REPLACE FUNCTION enforce_audit_log_append_only()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
BEGIN
  RAISE EXCEPTION
    'booking_audit_log is append-only: % operations are not permitted (correlation_id=%)',
    TG_OP,
    coalesce(current_setting('app.correlation_id', true), 'unknown')
  USING ERRCODE = 'insufficient_privilege';
  RETURN NULL;
END;
$$;

-- Attach the trigger (drop-then-create is idempotent)
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON booking_audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON booking_audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_append_only();

-- Revoke UPDATE and DELETE from the application role.
-- Wrapped in a DO block so an undefined role in CI/test environments
-- causes a logged skip rather than a migration failure.
DO $$
DECLARE
  app_role TEXT := coalesce(
    current_setting('app.role', true),
    'travel_app'
  );
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE ON booking_audit_log FROM %I', app_role);
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'REVOKE skipped: role % does not exist', app_role;
END $$;

-- Per-role fine-grained grants (INSERT + SELECT only)
DO $$
DECLARE
  roles TEXT[] := ARRAY['traveler', 'support_agent', 'ops', 'system'];
  r     TEXT;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    BEGIN
      EXECUTE format('GRANT INSERT, SELECT ON booking_audit_log TO %I', r);
    EXCEPTION
      WHEN undefined_object THEN
        RAISE NOTICE 'GRANT skipped: role % does not exist', r;
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Table: processed_events (idempotency store for webhook delivery, WO-072)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_events (
  id             UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider       VARCHAR(64)  NOT NULL,
  event_id       VARCHAR(256) NOT NULL,
  event_type     VARCHAR(128) NOT NULL,
  payload_digest CHAR(64)     NOT NULL,
  received_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);

-- Unique constraint — exactly-once authority for BR-03.
-- Wrapped in a DO block for idempotency (two concurrent deliveries of the
-- same event race on this constraint; the loser receives a unique_violation
-- and is treated as a duplicate, never as an error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE  constraint_name = 'uq_processed_events_provider_event'
    AND    table_name       = 'processed_events'
    AND    table_schema     = current_schema()
  ) THEN
    ALTER TABLE processed_events
      ADD CONSTRAINT uq_processed_events_provider_event
        UNIQUE (provider, event_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_processed_events_received_at
  ON processed_events(received_at);
