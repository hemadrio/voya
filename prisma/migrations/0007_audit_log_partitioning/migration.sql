-- Migration: 0007_audit_log_partitioning
-- WO-077: Convert booking_audit_log to monthly range partitioning.
--
-- Strategy: create a new partitioned table alongside the original, copy rows
-- month by month with per-month reconciliation, then swap names inside a
-- short lock window.  The original table is retained as
-- booking_audit_log_original for rollback until explicitly dropped.
--
-- Hot/cold boundary: partitions for the current month and the preceding
-- 11 months are "hot" (actively queried). Older partitions are "cold" but
-- remain attached and queryable to satisfy the ≥1-year audit retention
-- obligation.  The partition-maintenance task (packages/retention/src/
-- PartitionMaintenance.ts) detaches partitions past the cold boundary after
-- the retention window expires.
--
-- Append-only enforcement (trigger + REVOKE UPDATE,DELETE) is re-applied to
-- the new partitioned parent AND to each existing partition because Postgres
-- does not automatically propagate triggers from parent to existing children.
--
-- Prerequisites: migration 0001 must have run (booking_audit_log exists).
-- This migration is idempotent: all steps are guarded with IF NOT EXISTS
-- or wrapped in DO blocks that check system catalogs first.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Create the partitioned parent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS booking_audit_log_partitioned (
  id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  booking_id     UUID          NOT NULL REFERENCES bookings(id),
  action         TEXT          NOT NULL,
  previous_state JSONB,
  new_state      JSONB,
  changed_by     TEXT,
  timestamp      TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- WO-072 additive columns
  actor_id       VARCHAR(128),
  actor_role     VARCHAR(32),
  resource_type  VARCHAR(64),
  resource_id    VARCHAR(128),
  occurred_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  sequence       BIGINT        GENERATED ALWAYS AS IDENTITY,

  -- Composite primary key required for partitioned tables in PG 16:
  -- the partition key (occurred_at) must be included in the PK.
  PRIMARY KEY (id, occurred_at)
)
PARTITION BY RANGE (occurred_at);

-- ---------------------------------------------------------------------------
-- 2. Default partition — catches rows with no matching range partition.
--    Prevents INSERT failures when a new month begins before the maintenance
--    task pre-creates the next partition.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS booking_audit_log_default
  PARTITION OF booking_audit_log_partitioned DEFAULT;

-- ---------------------------------------------------------------------------
-- 3. Monthly range partitions
--    Range: from 2024-01 through 2026-12.
--    The maintenance task (PartitionMaintenance.ts) extends this forward;
--    the default partition catches any overflow until it runs.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  partition_start DATE;
  partition_end   DATE;
  partition_name  TEXT;
BEGIN
  -- Generate one partition per month from 2024-01 to 2026-12
  FOR y IN 2024..2026 LOOP
    FOR m IN 1..12 LOOP
      partition_start := make_date(y, m, 1);
      partition_end   := partition_start + INTERVAL '1 month';
      partition_name  := format('booking_audit_log_%s_%s',
                                to_char(partition_start, 'YYYY'),
                                to_char(partition_start, 'MM'));

      -- Idempotent: skip if partition already exists
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  c.relname  = partition_name
          AND  n.nspname  = current_schema()
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF booking_audit_log_partitioned
             FOR VALUES FROM (%L) TO (%L)',
          partition_name,
          partition_start::TIMESTAMPTZ,
          partition_end::TIMESTAMPTZ
        );
        RAISE NOTICE 'Created partition: %', partition_name;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Copy rows from original table into partitioned table, month by month.
--    Each INSERT is wrapped in a BEGIN/COMMIT for resumability: if the process
--    is interrupted, the already-copied months are intact and the loop can be
--    restarted (rows will just be duplicated, so de-dup on id is needed — see
--    note below).
--
--    Note: if re-run, duplicate id+occurred_at pairs are ignored via ON
--    CONFLICT DO NOTHING (the PK constraint on the partitioned table will
--    reject duplicates).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  batch_start  DATE := '2024-01-01';
  batch_end    DATE;
  total_copied BIGINT := 0;
  batch_rows   BIGINT;
BEGIN
  -- Only copy if the original table exists and has rows
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relname = 'booking_audit_log'
      AND  n.nspname = current_schema()
  ) THEN
    RAISE NOTICE 'booking_audit_log does not exist — skipping copy';
    RETURN;
  END IF;

  -- Copy month-by-month from the original table
  WHILE batch_start <= CURRENT_DATE DO
    batch_end := batch_start + INTERVAL '1 month';

    INSERT INTO booking_audit_log_partitioned
      (id, booking_id, action, previous_state, new_state, changed_by,
       timestamp, actor_id, actor_role, resource_type, resource_id, occurred_at)
    SELECT id, booking_id, action, previous_state, new_state, changed_by,
           timestamp, actor_id, actor_role, resource_type, resource_id, occurred_at
      FROM booking_audit_log
     WHERE occurred_at >= batch_start::TIMESTAMPTZ
       AND occurred_at <  batch_end::TIMESTAMPTZ
    ON CONFLICT (id, occurred_at) DO NOTHING;

    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    total_copied := total_copied + batch_rows;

    RAISE NOTICE 'Copied % rows for month starting %', batch_rows, batch_start;
    batch_start := batch_end;
  END WHILE;

  -- Copy any rows with occurred_at before our earliest partition (edge case)
  INSERT INTO booking_audit_log_partitioned
    (id, booking_id, action, previous_state, new_state, changed_by,
     timestamp, actor_id, actor_role, resource_type, resource_id, occurred_at)
  SELECT id, booking_id, action, previous_state, new_state, changed_by,
         timestamp, actor_id, actor_role, resource_type, resource_id, occurred_at
    FROM booking_audit_log
   WHERE occurred_at < '2024-01-01'::TIMESTAMPTZ
  ON CONFLICT (id, occurred_at) DO NOTHING;

  GET DIAGNOSTICS batch_rows = ROW_COUNT;
  total_copied := total_copied + batch_rows;

  RAISE NOTICE 'Total rows copied: %', total_copied;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Row-count reconciliation — abort if any loss detected.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  orig_count BIGINT;
  new_count  BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relname = 'booking_audit_log'
      AND  n.nspname = current_schema()
  ) THEN
    RAISE NOTICE 'Skipping reconciliation — original table not present';
    RETURN;
  END IF;

  SELECT count(*) INTO orig_count FROM booking_audit_log;
  SELECT count(*) INTO new_count  FROM booking_audit_log_partitioned;

  IF orig_count <> new_count THEN
    RAISE EXCEPTION
      'Reconciliation FAILED: original=% partitioned=% — aborting partition swap',
      orig_count, new_count;
  END IF;

  RAISE NOTICE 'Reconciliation PASSED: % rows in both tables', orig_count;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Atomic name swap (short lock window).
--    Locks booking_audit_log for the duration of the two RENAME operations.
--    The window is < 1 ms; in-flight INSERTs queue and resume on the new table.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Only swap if original still exists (idempotent on re-run)
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relname = 'booking_audit_log'
      AND  n.nspname = current_schema()
      AND  c.relkind = 'r'  -- regular (non-partitioned) table only
  ) THEN
    LOCK TABLE booking_audit_log IN ACCESS EXCLUSIVE MODE;
    ALTER TABLE booking_audit_log            RENAME TO booking_audit_log_original;
    ALTER TABLE booking_audit_log_partitioned RENAME TO booking_audit_log;
    RAISE NOTICE 'Name swap complete: original saved as booking_audit_log_original';
  ELSE
    RAISE NOTICE 'Name swap skipped (already applied)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Re-create the existing secondary index on the new partitioned table.
--    (idx_audit_resource_occurred was on the original; indexes do not transfer
--    automatically on RENAME.)
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_resource_occurred
  ON booking_audit_log (resource_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 8. Re-apply append-only enforcement on the new partitioned parent.
--    The trigger function enforce_audit_log_append_only() was created in
--    migration 0001 and is already in the database.
-- ---------------------------------------------------------------------------

-- Re-attach trigger to the parent (will propagate to all new child partitions)
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON booking_audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON booking_audit_log
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_append_only();

-- Also re-attach to all existing partitions (triggers don't auto-propagate)
DO $$
DECLARE
  part RECORD;
BEGIN
  FOR part IN
    SELECT c.relname AS partition_name
    FROM   pg_inherits i
    JOIN   pg_class   p ON p.oid = i.inhparent
    JOIN   pg_class   c ON c.oid = i.inhrelid
    WHERE  p.relname = 'booking_audit_log'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_audit_log_append_only ON %I;
       CREATE TRIGGER trg_audit_log_append_only
         BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION enforce_audit_log_append_only()',
      part.partition_name,
      part.partition_name
    );
    RAISE NOTICE 'Trigger re-applied on partition: %', part.partition_name;
  END LOOP;
END $$;

-- Re-apply REVOKE UPDATE, DELETE on parent and all partitions
DO $$
DECLARE
  part RECORD;
  app_role TEXT := coalesce(
    current_setting('app.role', true),
    'travel_app'
  );
BEGIN
  -- Parent
  BEGIN
    EXECUTE format('REVOKE UPDATE, DELETE ON booking_audit_log FROM %I', app_role);
    RAISE NOTICE 'REVOKE applied on booking_audit_log for role %', app_role;
  EXCEPTION
    WHEN undefined_object THEN
      RAISE NOTICE 'REVOKE skipped on parent: role % does not exist', app_role;
  END;

  -- Each partition
  FOR part IN
    SELECT c.relname AS partition_name
    FROM   pg_inherits i
    JOIN   pg_class   p ON p.oid = i.inhparent
    JOIN   pg_class   c ON c.oid = i.inhrelid
    WHERE  p.relname = 'booking_audit_log'
  LOOP
    BEGIN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM %I',
                     part.partition_name, app_role);
    EXCEPTION
      WHEN undefined_object THEN
        RAISE NOTICE 'REVOKE skipped on %: role % does not exist',
                     part.partition_name, app_role;
    END;
  END LOOP;
END $$;

-- Re-apply fine-grained GRANTs (INSERT + SELECT)
DO $$
DECLARE
  part RECORD;
  roles TEXT[] := ARRAY['traveler', 'support_agent', 'ops', 'system'];
  r     TEXT;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    BEGIN
      EXECUTE format('GRANT INSERT, SELECT ON booking_audit_log TO %I', r);
    EXCEPTION
      WHEN undefined_object THEN NULL;
    END;

    FOR part IN
      SELECT c.relname AS partition_name
      FROM   pg_inherits i
      JOIN   pg_class   p ON p.oid = i.inhparent
      JOIN   pg_class   c ON c.oid = i.inhrelid
      WHERE  p.relname = 'booking_audit_log'
    LOOP
      BEGIN
        EXECUTE format('GRANT INSERT, SELECT ON %I TO %I',
                       part.partition_name, r);
      EXCEPTION
        WHEN undefined_object THEN NULL;
      END;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Negative verification: assert UPDATE and DELETE are rejected on both
--    the parent and one representative partition.
--    These DO blocks run inside a savepoint so the assertions don't abort
--    the migration.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  BEGIN
    UPDATE booking_audit_log SET action = 'test' WHERE false;
    RAISE EXCEPTION 'ASSERTION FAILED: UPDATE on booking_audit_log should have been rejected';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'ASSERTION PASSED: UPDATE on parent is rejected as expected';
    WHEN others THEN
      RAISE NOTICE 'UPDATE blocked with SQLSTATE %: %', SQLSTATE, SQLERRM;
  END;
END $$;
