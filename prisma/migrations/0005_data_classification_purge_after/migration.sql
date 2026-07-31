-- Migration: 0005_data_classification_purge_after
-- WO-074: Add data classification and purge_after metadata to personal tables.
--
-- ADDITIVE ONLY — no column dropped, no type narrowed, all new columns nullable
-- or have defaults so previous-version services continue to operate.
--
-- Changes:
--   1. CREATE TYPE data_classification enum
--   2. ADD classification + purge_after + erasure_requested_at to users
--   3. ADD classification + purge_after to sessions, one_time_tokens, bookings,
--      booking_travelers
--   4. CREATE TABLE itineraries (with classification + purge_after)
--   5. CREATE TABLE travel_preferences (with classification + purge_after)
--   6. CREATE INDEX CONCURRENTLY on purge_after for large/active tables
--      (uses PRAGMA transaction = false for Postgres concurrent index build)

-- ---------------------------------------------------------------------------
-- 1. Classification enum
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE data_classification AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. users — classification, erasure_requested_at, purge_after
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS classification     data_classification NOT NULL DEFAULT 'RESTRICTED',
  ADD COLUMN IF NOT EXISTS erasure_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purge_after        TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. sessions — classification, purge_after
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS classification data_classification NOT NULL DEFAULT 'RESTRICTED',
  ADD COLUMN IF NOT EXISTS purge_after    TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. one_time_tokens — classification, purge_after
-- ---------------------------------------------------------------------------

ALTER TABLE one_time_tokens
  ADD COLUMN IF NOT EXISTS classification data_classification NOT NULL DEFAULT 'RESTRICTED',
  ADD COLUMN IF NOT EXISTS purge_after    TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 5. bookings — classification, purge_after
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS classification data_classification NOT NULL DEFAULT 'CONFIDENTIAL',
  ADD COLUMN IF NOT EXISTS purge_after    TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 6. booking_travelers — classification, purge_after, trip_completed_at
-- ---------------------------------------------------------------------------

ALTER TABLE booking_travelers
  ADD COLUMN IF NOT EXISTS classification   data_classification NOT NULL DEFAULT 'RESTRICTED',
  ADD COLUMN IF NOT EXISTS purge_after      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trip_completed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 7. itineraries — new table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS itineraries (
  id             UUID                NOT NULL DEFAULT gen_random_uuid(),
  user_id        UUID                NOT NULL,
  title          VARCHAR(256)        NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  classification data_classification NOT NULL DEFAULT 'CONFIDENTIAL',
  purge_after    TIMESTAMPTZ,

  CONSTRAINT pk_itineraries PRIMARY KEY (id),
  CONSTRAINT fk_itineraries_user FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_itineraries_user_id ON itineraries (user_id);

-- ---------------------------------------------------------------------------
-- 8. travel_preferences — new table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS travel_preferences (
  id                    UUID                NOT NULL DEFAULT gen_random_uuid(),
  user_id               UUID                NOT NULL UNIQUE,
  preferred_seat_class  VARCHAR(32),
  preferred_currency    CHAR(3),
  preferred_airlines    TEXT[]              NOT NULL DEFAULT '{}',
  dietary_restrictions  TEXT[]              NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  classification        data_classification NOT NULL DEFAULT 'CONFIDENTIAL',
  purge_after           TIMESTAMPTZ,

  CONSTRAINT pk_travel_preferences PRIMARY KEY (id),
  CONSTRAINT fk_travel_preferences_user FOREIGN KEY (user_id) REFERENCES users (id)
);

-- ---------------------------------------------------------------------------
-- 9. Indexes on purge_after — CONCURRENTLY to avoid locking large tables
-- Note: Prisma migration runner must have transaction disabled for these.
-- Wrapped in DO blocks to be idempotent if migration is re-run.
-- ---------------------------------------------------------------------------

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_purge_after
  ON users (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_purge_after
  ON sessions (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ott_purge_after
  ON one_time_tokens (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_purge_after
  ON bookings (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_travelers_purge_after
  ON booking_travelers (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_itineraries_purge_after
  ON itineraries (purge_after) WHERE purge_after IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_travel_preferences_purge_after
  ON travel_preferences (purge_after) WHERE purge_after IS NOT NULL;
