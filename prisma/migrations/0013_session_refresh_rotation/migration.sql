-- Migration: 0013_session_refresh_rotation
-- WO-022: Refresh token rotation with reuse detection.
--
-- Changes:
--   1. Add absolute_expires_at (TIMESTAMPTZ, nullable) to sessions.
--      Copied verbatim through every rotation so the absolute lifetime
--      can never be extended by repeated refreshes.
--   2. Backfill family_id for existing rows where it is NULL, using the
--      session id as the family root (each existing session becomes its
--      own family).
--   3. Add index on sessions.family_id for efficient family-wide revocation.
--   4. Add index on sessions.revoked_at for cleanup queries.
--   5. Add composite index on (expires_at, revoked_at) for the cleanup job
--      that prunes expired and old-revoked sessions.
--
-- All DDL is additive and idempotent (IF NOT EXISTS / IF NOT EXISTS guards).
-- ---------------------------------------------------------------------------

-- 1. Add absolute_expires_at
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS absolute_expires_at TIMESTAMPTZ;

-- 2. Backfill family_id for rows where it is NULL.
--    Each existing session becomes the root of its own single-member family.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'family_id'
  ) THEN
    UPDATE sessions
       SET family_id = id
     WHERE family_id IS NULL;
    RAISE NOTICE 'Backfilled family_id for % rows', (SELECT count(*) FROM sessions WHERE family_id = id);
  ELSE
    RAISE NOTICE 'family_id column not present — skipping backfill (run after 0002 migration)';
  END IF;
END $$;

-- 3. Index on family_id for one-query family revocation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_family_id
  ON sessions (family_id)
  WHERE family_id IS NOT NULL;

-- 4. Index on revoked_at for cleanup job.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_revoked_at
  ON sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;

-- 5. Composite index for the cleanup job: expired AND old-revoked rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_cleanup
  ON sessions (expires_at, revoked_at);
