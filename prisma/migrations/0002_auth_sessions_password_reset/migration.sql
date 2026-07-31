-- Migration: 0002_auth_sessions_password_reset
-- Strategy: expand/contract — all changes are additive.
-- Adds session metadata columns, user lockout columns, and the one_time_tokens table.
-- All new session/user columns are nullable or defaulted so previous-version
-- service rows remain valid without backfill.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Session metadata columns (WO-024)
-- ---------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS family_id          UUID,
  ADD COLUMN IF NOT EXISTS revoked_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ip_address         VARCHAR(45),
  ADD COLUMN IF NOT EXISTS user_agent         VARCHAR(512),
  ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sessions_user_revoked
  ON sessions (user_id, revoked_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. User lockout columns (WO-024)
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. OneTimeToken table (WO-024)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS one_time_tokens (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id),
  purpose     VARCHAR(64) NOT NULL,
  token_hash  CHAR(64)    NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ott_user_purpose_consumed
  ON one_time_tokens (user_id, purpose, consumed_at)
  WHERE consumed_at IS NULL;
