-- Migration: 0004_booking_travelers_kms_encryption
-- WO-073: Normalize traveler identity documents with KMS envelope encryption.
--
-- This migration is ADDITIVE — no column is dropped, no type is narrowed.
-- The legacy Booking.passengers JSON column continues to be written during
-- the backward-compatible window and is dropped in a separate contract
-- migration story.
--
-- Changes:
--   1. Add travelers_migrated_at to bookings (backfill progress marker)
--   2. Create booking_travelers table with encrypted fields (bytea)
--   3. Revoke column-level SELECT on encrypted columns from support_agent
--   4. Grant booking-service role full access to booking_travelers
--
-- Expand/contract safety: all new columns are nullable or have defaults.
-- Previous-version service instances that omit travelers_migrated_at on
-- INSERT produce valid rows because the column defaults to NULL.

-- ---------------------------------------------------------------------------
-- 1. Backfill progress marker on bookings
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS travelers_migrated_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_travelers_migrated_at
  ON bookings (travelers_migrated_at);

-- ---------------------------------------------------------------------------
-- 2. Create booking_travelers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS booking_travelers (
  id                         UUID        NOT NULL DEFAULT gen_random_uuid(),
  booking_id                 UUID        NOT NULL,
  given_name                 TEXT        NOT NULL,
  family_name                TEXT        NOT NULL,
  email                      TEXT,

  -- AES-256-GCM ciphertext (body || 16-byte auth tag)
  encrypted_date_of_birth    BYTEA,
  encrypted_dob_iv           BYTEA,
  encrypted_passport_reference BYTEA,
  encrypted_passport_iv      BYTEA,

  -- KMS envelope fields
  wrapped_dek                BYTEA       NOT NULL,
  dek_key_id                 VARCHAR(2048) NOT NULL,
  encryption_context         JSONB       NOT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_booking_travelers PRIMARY KEY (id),
  CONSTRAINT fk_booking_travelers_booking
    FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_booking_travelers_booking_id
  ON booking_travelers (booking_id);

-- ---------------------------------------------------------------------------
-- 3. Column-level privilege revocation (support_agent least-privilege, BR-10)
-- ---------------------------------------------------------------------------
-- The support_agent role may view and cancel bookings but must NEVER read
-- traveler identity documents.  Column-level REVOKE is a defence-in-depth
-- layer on top of predicate-based ownership checks.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'support_agent'
  ) THEN
    REVOKE SELECT (encrypted_date_of_birth, encrypted_dob_iv,
                   encrypted_passport_reference, encrypted_passport_iv,
                   wrapped_dek)
      ON booking_travelers
      FROM support_agent;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Grant booking-service role access
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'booking_service'
  ) THEN
    GRANT SELECT, INSERT ON booking_travelers TO booking_service;
    GRANT SELECT, UPDATE (travelers_migrated_at) ON bookings TO booking_service;
  END IF;
END
$$;
