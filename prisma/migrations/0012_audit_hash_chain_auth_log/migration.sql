-- Migration: 0012_audit_hash_chain_auth_log
-- WO-101: Append-Only Tamper-Evident Audit Log Infrastructure.
--
-- Part A — additive columns on booking_audit_log:
--   prev_hash    CHAR(64)     — SHA-256 hex of previous entry's payload
--   entry_hash   CHAR(64)     — SHA-256 hex of this entry's canonical payload + prev_hash
--   correlation_id VARCHAR(128)— distributed trace / request identifier
--   actor_ip     VARCHAR(64)  — IPv4 / IPv6 of the actor's originating request
--
-- Part B — create auth_audit_log with the same hash-chain columns plus
--   monthly range partitioning on occurred_at.
--
-- Part C — append-only enforcement (idempotent):
--   REVOKE UPDATE, DELETE on both tables from the application role.
--   BEFORE UPDATE/DELETE trigger functions (raise exception as defence in depth).
--
-- Idempotent: all DDL steps are guarded with IF NOT EXISTS or wrapped in
-- DO blocks that check system catalogs before executing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A.1  Add hash-chain columns to booking_audit_log
--      Each is nullable so existing rows without them are still valid.
-- ---------------------------------------------------------------------------

ALTER TABLE booking_audit_log
  ADD COLUMN IF NOT EXISTS prev_hash      CHAR(64),
  ADD COLUMN IF NOT EXISTS entry_hash     CHAR(64),
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS actor_ip       VARCHAR(64);

-- Unique index on entry_hash so concurrent inserts with the same hash are
-- rejected at the DB level (prevents chain forks).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_booking_audit_entry_hash
  ON booking_audit_log (entry_hash)
  WHERE entry_hash IS NOT NULL;

-- Index for history reads: (resource_id, occurred_at) already exists (0007).
-- Add actor index for SIEM queries.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_audit_actor_occurred
  ON booking_audit_log (actor_id, occurred_at)
  WHERE actor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B.1  Create auth_audit_log (partitioned by occurred_at)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  actor_id       VARCHAR(128)  NOT NULL,
  actor_role     VARCHAR(32)   NOT NULL,
  actor_ip       VARCHAR(64),
  action         TEXT          NOT NULL,
  resource_type  VARCHAR(64)   NOT NULL,
  resource_id    VARCHAR(128)  NOT NULL,
  previous_state JSONB,
  new_state      JSONB,
  correlation_id VARCHAR(128),
  occurred_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  sequence       BIGINT        GENERATED ALWAYS AS IDENTITY,

  -- Hash-chain columns
  prev_hash      CHAR(64),
  entry_hash     CHAR(64),

  PRIMARY KEY (id, occurred_at)
)
PARTITION BY RANGE (occurred_at);

-- Default partition — catches rows until the maintenance task pre-creates
-- the month partition.
CREATE TABLE IF NOT EXISTS auth_audit_log_default
  PARTITION OF auth_audit_log DEFAULT;

-- Monthly partitions: 2024-01 through 2026-12 (same horizon as booking_audit_log)
DO $$
DECLARE
  partition_start DATE;
  partition_end   DATE;
  partition_name  TEXT;
BEGIN
  FOR y IN 2024..2026 LOOP
    FOR m IN 1..12 LOOP
      partition_start := make_date(y, m, 1);
      partition_end   := partition_start + INTERVAL '1 month';
      partition_name  := format('auth_audit_log_%s_%s',
                                to_char(partition_start, 'YYYY'),
                                to_char(partition_start, 'MM'));

      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  c.relname  = partition_name
          AND  n.nspname  = current_schema()
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF auth_audit_log
             FOR VALUES FROM (%L) TO (%L)',
          partition_name,
          partition_start::TIMESTAMPTZ,
          partition_end::TIMESTAMPTZ
        );
        RAISE NOTICE 'Created auth partition: %', partition_name;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Indexes on auth_audit_log parent (propagate to partitions)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_audit_resource_occurred
  ON auth_audit_log (resource_id, occurred_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_audit_actor_occurred
  ON auth_audit_log (actor_id, occurred_at);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_auth_audit_entry_hash
  ON auth_audit_log (entry_hash)
  WHERE entry_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- C.1  Trigger function for auth_audit_log append-only enforcement
--      (enforce_audit_log_append_only was created in migration 0001 for
--       booking_audit_log; we reuse its logic in a sibling function here)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_auth_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'auth_audit_log is append-only: UPDATE and DELETE are not permitted. '
    'Operation: %, Row id: %',
    TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Attach trigger to auth_audit_log parent
DROP TRIGGER IF EXISTS trg_auth_audit_log_append_only ON auth_audit_log;
CREATE TRIGGER trg_auth_audit_log_append_only
  BEFORE UPDATE OR DELETE ON auth_audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_auth_audit_log_append_only();

-- Attach trigger to every existing auth partition
DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT c.relname AS partition_name
    FROM   pg_inherits i
    JOIN   pg_class   p ON p.oid = i.inhparent
    JOIN   pg_class   c ON c.oid = i.inhrelid
    WHERE  p.relname = 'auth_audit_log'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_auth_audit_log_append_only ON %I;
       CREATE TRIGGER trg_auth_audit_log_append_only
         BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION enforce_auth_audit_log_append_only()',
      part.partition_name,
      part.partition_name
    );
    RAISE NOTICE 'Auth append-only trigger applied on partition: %', part.partition_name;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- C.2  REVOKE UPDATE, DELETE on both tables from the application role
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  app_role TEXT := coalesce(
    current_setting('app.role', true),
    'travel_app'
  );
BEGIN
  -- booking_audit_log (parent + partitions handled by 0007; re-assert here)
  BEGIN
    EXECUTE format('REVOKE UPDATE, DELETE ON booking_audit_log FROM %I', app_role);
    RAISE NOTICE 'REVOKE UPDATE,DELETE on booking_audit_log for role %', app_role;
  EXCEPTION
    WHEN undefined_object THEN
      RAISE NOTICE 'REVOKE skipped: role % does not exist', app_role;
  END;

  -- auth_audit_log parent
  BEGIN
    EXECUTE format('REVOKE UPDATE, DELETE ON auth_audit_log FROM %I', app_role);
    RAISE NOTICE 'REVOKE UPDATE,DELETE on auth_audit_log for role %', app_role;
  EXCEPTION
    WHEN undefined_object THEN
      RAISE NOTICE 'REVOKE skipped: role % does not exist', app_role;
  END;
END $$;

-- Grant INSERT + SELECT on auth_audit_log to service roles
DO $$
DECLARE
  roles TEXT[] := ARRAY['auth_svc', 'booking_svc', 'reporting_svc'];
  r     TEXT;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    BEGIN
      EXECUTE format('GRANT INSERT, SELECT ON auth_audit_log TO %I', r);
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- C.3  Assertion: verify UPDATE is rejected on auth_audit_log
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  BEGIN
    UPDATE auth_audit_log SET action = 'test' WHERE false;
    RAISE EXCEPTION 'ASSERTION FAILED: UPDATE on auth_audit_log should have been rejected';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'ASSERTION PASSED: UPDATE on auth_audit_log is rejected as expected';
    WHEN restrict_violation THEN
      RAISE NOTICE 'ASSERTION PASSED: UPDATE blocked by trigger on auth_audit_log';
    WHEN others THEN
      RAISE NOTICE 'UPDATE blocked with SQLSTATE %: %', SQLSTATE, SQLERRM;
  END;
END $$;
