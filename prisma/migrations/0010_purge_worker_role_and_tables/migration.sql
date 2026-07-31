-- Migration: 0010_purge_worker_role_and_tables
-- WO-075: Retention purge worker — system role with scoped GRANTs, purge audit
--         tables, and a run-lease table for preventing concurrent runs.
--
-- Security:
--   - purge_worker role has DELETE on all personal-data tables EXCEPT booking_audit_log
--   - purge_worker has UPDATE on booking_travelers (wrapped_dek nullification)
--   - purge_worker has INSERT on purge_runs, purge_quarantine (immutable audit trail)
--   - purge_worker has SELECT on pg_stat_activity (load factor estimation)
--   - No DROP, TRUNCATE, or DDL grants
--
-- Tables:
--   purge_runs          — immutable audit record for every purge run
--   purge_quarantine    — rows flagged as unable to be purged normally
--   purge_lease         — single-row run lease preventing concurrent executions

-- ---------------------------------------------------------------------------
-- 1. System role: purge_worker
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE ROLE purge_worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Grant SELECT on all personal-data tables (for countExpired / fetch)
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE
  users,
  sessions,
  one_time_tokens,
  bookings,
  booking_travelers,
  itineraries,
  travel_preferences,
  booking_audit_log
TO purge_worker;

-- ---------------------------------------------------------------------------
-- 3. Grant DELETE on personal-data tables (physical delete)
--    NOTE: booking_audit_log intentionally excluded (immutable audit log)
-- ---------------------------------------------------------------------------

GRANT DELETE ON TABLE
  users,
  sessions,
  one_time_tokens,
  bookings,
  booking_travelers,
  itineraries,
  travel_preferences
TO purge_worker;

-- ---------------------------------------------------------------------------
-- 4. Grant UPDATE on booking_travelers for wrapped_dek nullification
--    (crypto-erasure: nullify the wrapped_dek column)
-- ---------------------------------------------------------------------------

GRANT UPDATE (wrapped_dek, dek_key_id) ON TABLE booking_travelers TO purge_worker;

-- ---------------------------------------------------------------------------
-- 5. Grant UPDATE on users for pseudonymisation (actor_id replacement)
-- ---------------------------------------------------------------------------

GRANT UPDATE (actor_id) ON TABLE booking_audit_log TO purge_worker;

-- ---------------------------------------------------------------------------
-- 6. purge_runs — immutable audit record per category sweep
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purge_runs (
  id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
  category            VARCHAR(128)  NOT NULL,
  entry_id            VARCHAR(64)   NOT NULL,
  correlation_id      UUID          NOT NULL,
  started_at          TIMESTAMPTZ   NOT NULL,
  finished_at         TIMESTAMPTZ   NOT NULL,
  examined            BIGINT        NOT NULL DEFAULT 0,
  purged              BIGINT        NOT NULL DEFAULT 0,
  keys_destroyed      BIGINT        NOT NULL DEFAULT 0,
  status              VARCHAR(32)   NOT NULL CHECK (status IN ('success','partial','skipped','failure')),
  error_message       TEXT,
  dry_run             BOOLEAN       NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_purge_runs PRIMARY KEY (id)
);

-- Index for recent-run queries (operational dashboards)
CREATE INDEX IF NOT EXISTS idx_purge_runs_started_at ON purge_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_purge_runs_category   ON purge_runs (category, started_at DESC);

-- ---------------------------------------------------------------------------
-- 7. purge_quarantine — rows that could not be purged normally
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purge_quarantine (
  id                  UUID          NOT NULL DEFAULT gen_random_uuid(),
  table_name          VARCHAR(128)  NOT NULL,
  row_id              UUID          NOT NULL,
  reason              VARCHAR(256)  NOT NULL,
  correlation_id      UUID          NOT NULL,
  quarantined_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,

  CONSTRAINT pk_purge_quarantine PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purge_quarantine_row
  ON purge_quarantine (table_name, row_id)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8. purge_lease — single-row run lease (prevents concurrent executions)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purge_lease (
  lease_key           VARCHAR(64)   NOT NULL,
  acquired_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ   NOT NULL,
  holder_id           VARCHAR(128),

  CONSTRAINT pk_purge_lease PRIMARY KEY (lease_key)
);

-- ---------------------------------------------------------------------------
-- 9. Grant INSERT/SELECT/DELETE on purge tables to purge_worker
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON TABLE purge_runs TO purge_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE purge_quarantine TO purge_worker;
GRANT SELECT, INSERT, DELETE ON TABLE purge_lease TO purge_worker;

-- ---------------------------------------------------------------------------
-- 10. Grant SELECT on pg_stat_activity for DB load factor estimation
--     (read-only, limited to seeing connection counts)
-- ---------------------------------------------------------------------------

GRANT SELECT ON pg_catalog.pg_stat_activity TO purge_worker;
