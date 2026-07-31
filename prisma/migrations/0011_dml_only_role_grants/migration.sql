-- Migration: 0011_dml_only_role_grants
-- Strategy: expand/contract — grants are additive; no existing data changed.
-- Enforces the DDL-privilege constraint from WO-086:
--   - migration_task PostgreSQL role retains full DDL rights (CREATEDB or
--     schema-owner level on the travel schema).
--   - All per-service roles (booking_svc, auth_svc, payment_svc, user_svc,
--     itinerary_svc, reporting_svc, notification_svc) are restricted to
--     DML only (SELECT, INSERT, UPDATE, DELETE) on their schema objects.
--   - Service roles explicitly cannot CREATE TABLE, ALTER TABLE, DROP TABLE,
--     CREATE INDEX, DROP INDEX, or execute any other DDL statement.
--
-- This migration is idempotent: GRANT/REVOKE statements are safe to re-run.
-- The ECS migration task runs as migration_task (DDL-capable); all service
-- ECS tasks run as their respective per-service roles (DML-only).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Revoke DDL privileges from all per-service database roles.
-- Each REVOKE is wrapped in a DO block so a non-existent role causes a
-- logged NOTICE rather than aborting the migration transaction.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  service_roles TEXT[] := ARRAY[
    'booking_svc',
    'auth_svc',
    'payment_svc',
    'user_svc',
    'itinerary_svc',
    'reporting_svc',
    'notification_svc'
  ];
  r TEXT;
BEGIN
  FOREACH r IN ARRAY service_roles LOOP
    BEGIN
      -- Revoke CREATE on the public schema (prevents CREATE TABLE, CREATE INDEX, etc.)
      EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
      -- Revoke CONNECT ability to create schema objects
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      RAISE NOTICE 'Revoked DDL from role %', r;
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE 'Role % does not exist — DDL revoke skipped', r;
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grant DML-only privileges to each per-service role on their schema objects.
-- Each service role gets exactly SELECT + INSERT + UPDATE + DELETE.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  service_roles TEXT[] := ARRAY[
    'booking_svc',
    'auth_svc',
    'payment_svc',
    'user_svc',
    'itinerary_svc',
    'reporting_svc',
    'notification_svc'
  ];
  r TEXT;
BEGIN
  FOREACH r IN ARRAY service_roles LOOP
    BEGIN
      -- Grant only DML operations — no DDL, no schema modification.
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
        r
      );
      -- Ensure future tables are also DML-only for this role.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        r
      );
      -- Grant usage on sequences (needed for SERIAL/IDENTITY columns).
      EXECUTE format(
        'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I',
        r
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO %I',
        r
      );
      RAISE NOTICE 'Granted DML-only to role %', r;
    EXCEPTION WHEN undefined_object THEN
      RAISE NOTICE 'Role % does not exist — DML grant skipped (will apply when role is created)', r;
    END;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Negative-test assertion: verify that a service role cannot execute DDL.
-- This block is only executed in test environments (controlled by the
-- RUN_DDL_NEGATIVE_TEST environment variable set by the CI compat-gate).
-- In production the DO block exits early, leaving schema unchanged.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- In CI the compat-gate sets this to '1' to verify the REVOKE took effect.
  -- In production (migration_task user) this variable is not set.
  IF current_setting('app.run_ddl_negative_test', true) = '1' THEN
    BEGIN
      -- Attempt DDL as the current role (expected to fail for service roles).
      EXECUTE 'CREATE TABLE IF NOT EXISTS ddl_negative_test_probe (id INT)';
      -- If we reach here the DDL succeeded — this is an error for service roles.
      RAISE EXCEPTION
        'DDL NEGATIVE TEST FAILED: role % was able to CREATE TABLE. '
        'Service roles must not hold DDL privileges.',
        current_user;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'DDL negative test PASSED: role % correctly denied CREATE TABLE', current_user;
    END;
  END IF;
END;
$$;
