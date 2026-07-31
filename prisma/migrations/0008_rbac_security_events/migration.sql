-- Migration 0008: RBAC role enum and append-only security events table
--
-- Changes:
--   1. Create UserRole enum (traveler, support_agent, system)
--   2. Migrate users.role from VARCHAR to UserRole enum
--   3. Create security_events table (append-only)
--   4. Indexes: (actor_id, occurred_at) and (resource_type, resource_id)
--   5. REVOKE UPDATE, DELETE on security_events to enforce append-only
--   6. Index bookings(user_id, created_at DESC) and itineraries(user_id) already exist

-- ── Step 1: Create the UserRole enum ────────────────────────────────────────

CREATE TYPE "UserRole" AS ENUM ('traveler', 'support_agent', 'system');

-- ── Step 2: Migrate users.role from VARCHAR to UserRole enum ────────────────

-- Backfill any NULL or unrecognised values before the type change
UPDATE "users" SET "role" = 'traveler' WHERE "role" NOT IN ('traveler', 'support_agent', 'system');

ALTER TABLE "users"
  ALTER COLUMN "role" TYPE "UserRole" USING "role"::"UserRole",
  ALTER COLUMN "role" SET DEFAULT 'traveler'::"UserRole";

-- ── Step 3: Create the append-only security_events table ────────────────────

CREATE TABLE "security_events" (
  "id"            UUID          NOT NULL DEFAULT gen_random_uuid(),
  "actor_id"      VARCHAR(128)  NOT NULL,
  "actor_role"    "UserRole"    NOT NULL,
  "resource_type" VARCHAR(64)   NOT NULL,
  "resource_id"   VARCHAR(128),
  "operation"     VARCHAR(64)   NOT NULL,
  "decision"      VARCHAR(10)   NOT NULL,
  "reason"        VARCHAR(512),
  "occurred_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- ── Step 4: Indexes ──────────────────────────────────────────────────────────

CREATE INDEX "idx_security_events_actor_occurred"
  ON "security_events" ("actor_id", "occurred_at");

CREATE INDEX "idx_security_events_resource"
  ON "security_events" ("resource_type", "resource_id");

-- ── Step 5: Append-only enforcement ─────────────────────────────────────────
-- The application role (travel_app) gets INSERT only.
-- REVOKE UPDATE and DELETE from PUBLIC as defence-in-depth.
-- The specific GRANT to travel_app is managed by the RDS IAM policy.

REVOKE UPDATE, DELETE ON "security_events" FROM PUBLIC;

-- Trigger as a secondary guard: even if REVOKE is accidentally relaxed,
-- UPDATE and DELETE raise an exception at the storage layer.

CREATE OR REPLACE FUNCTION prevent_security_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only; UPDATE and DELETE are forbidden';
END;
$$;

CREATE TRIGGER trg_security_events_append_only
  BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_security_event_mutation();
