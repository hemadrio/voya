-- Migration: 0020_subject_data_keys
-- WO-104: Restricted-Field Envelope Encryption and PII Log Redaction
--
-- Adds the subject_data_keys table for the per-subject KMS-wrapped DEK registry.
-- This table centralises key management for envelope encryption:
--   - One row per (user_id, key_version) pair
--   - destroyed_at enables cryptographic erasure without CMK destruction
--   - Separate from booking_travelers to support key rotation and cross-booking reuse
--
-- All DDL is idempotent (IF NOT EXISTS guards).

-- ---------------------------------------------------------------------------
-- 1. Create subject_data_keys table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subject_data_keys (
  id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Subject identifier: the user UUID this key belongs to
  user_id      UUID        NOT NULL,

  -- Monotonically increasing version within this subject's key history
  key_version  INTEGER     NOT NULL,

  -- KMS-wrapped DEK (GenerateDataKey CiphertextBlob) — never plaintext
  wrapped_key  BYTEA       NOT NULL,

  -- ARN/ID of the CMK used to wrap this DEK (for multi-CMK key rotation)
  dek_key_id   VARCHAR(2048) NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- When non-null: key has been cryptographically erased; ciphertext is unrecoverable
  destroyed_at TIMESTAMPTZ NULL
);

-- ---------------------------------------------------------------------------
-- 2. Unique constraint: one key per (user_id, key_version) pair
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'uq_subject_data_keys_user_version'
      AND table_name = 'subject_data_keys'
  ) THEN
    ALTER TABLE subject_data_keys
      ADD CONSTRAINT uq_subject_data_keys_user_version
      UNIQUE (user_id, key_version);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_subject_data_keys_user_id
  ON subject_data_keys (user_id);

CREATE INDEX IF NOT EXISTS idx_subject_data_keys_destroyed_at
  ON subject_data_keys (destroyed_at)
  WHERE destroyed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Role grants
-- ---------------------------------------------------------------------------

-- booking-service: full access to manage DEK lifecycle
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'booking_service') THEN
    GRANT SELECT, INSERT, UPDATE ON subject_data_keys TO booking_service;
  END IF;
END $$;

-- support_agent: may see key metadata (version, created_at) but NOT wrapped_key
-- Column-level grant: SELECT all columns EXCEPT wrapped_key
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_agent') THEN
    GRANT SELECT (id, user_id, key_version, dek_key_id, created_at, destroyed_at)
      ON subject_data_keys TO support_agent;
    -- Deliberately omit: wrapped_key — support_agent must never access DEKs
  END IF;
END $$;

-- purge_worker: UPDATE to set destroyed_at during cryptographic erasure
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'purge_worker') THEN
    GRANT SELECT, UPDATE (destroyed_at) ON subject_data_keys TO purge_worker;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Comment
-- ---------------------------------------------------------------------------

COMMENT ON TABLE subject_data_keys IS
  'Per-subject KMS-wrapped DEK registry for AES-256-GCM envelope encryption. '
  'Cryptographic erasure: set destroyed_at to permanently revoke access to '
  'all ciphertext encrypted under this key. WO-104.';

COMMENT ON COLUMN subject_data_keys.wrapped_key IS
  'KMS GenerateDataKey CiphertextBlob. Never stored or logged in plaintext. '
  'Decrypt via KMS.Decrypt with matching encryption context.';

COMMENT ON COLUMN subject_data_keys.destroyed_at IS
  'When non-null: key has been cryptographically erased. All ciphertext '
  'encrypted under this key is permanently unrecoverable. Set by the '
  'purge worker or an explicit erasure request.';
