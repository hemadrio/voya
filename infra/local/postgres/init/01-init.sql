-- PostgreSQL initialization for local development.
-- Executed once on the first container start when the data volume is empty.
-- Idempotent: safe to re-run (all statements use IF NOT EXISTS / DO blocks).
--
-- SECURITY: development-only placeholders — no production credentials here.
-- max_connections is set via the postgres command flag in docker-compose.yml.
-- See the connection budget in the compose file header.

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ── Application role (least-privilege) ──────────────────────────────────────
-- travel_app: used by services in non-migration contexts.
-- Separate from the postgres superuser so schema migrations require an
-- explicit elevated-privilege connection string.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'travel_app') THEN
    CREATE ROLE travel_app WITH LOGIN PASSWORD 'travel_app_local_dev';
  END IF;
END;
$$;

-- ── Grant schema access ──────────────────────────────────────────────────────
GRANT CONNECT ON DATABASE travel_dev TO travel_app;
GRANT USAGE ON SCHEMA public TO travel_app;

-- Default privileges: new tables/sequences created by postgres (superuser)
-- during migrations are accessible to travel_app immediately.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO travel_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO travel_app;

-- ── Migration role ───────────────────────────────────────────────────────────
-- travel_migration: elevated role for running Prisma migrations.
-- Has CREATE privilege on the schema; services do not use this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'travel_migration') THEN
    CREATE ROLE travel_migration WITH LOGIN PASSWORD 'travel_migration_local_dev';
  END IF;
END;
$$;

GRANT ALL PRIVILEGES ON DATABASE travel_dev TO travel_migration;
GRANT ALL PRIVILEGES ON SCHEMA public TO travel_migration;
