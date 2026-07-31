-- Migration: 0003_notification_processed_event_suppression
-- Strategy: expand/contract — all changes are additive new tables.
-- Adds notification_processed_events and email_suppressions tables for WO-052.
-- Both tables are new; no existing columns are modified so previous-version
-- services remain fully compatible.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. SuppressionReason enum type
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "SuppressionReason" AS ENUM ('BOUNCE', 'COMPLAINT', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. notification_processed_events — exactly-once idempotency store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_processed_events (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider        VARCHAR(64) NOT NULL,
  event_id        VARCHAR(256) NOT NULL,
  handler         VARCHAR(128) NOT NULL,
  correlation_id  VARCHAR(256) NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_processed_event_provider_event
  ON notification_processed_events (provider, event_id);

CREATE INDEX IF NOT EXISTS idx_notification_processed_event_processed_at
  ON notification_processed_events (processed_at);

-- ---------------------------------------------------------------------------
-- 3. email_suppressions — bounce/complaint suppression list
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash      VARCHAR(64) NOT NULL PRIMARY KEY,
  reason          "SuppressionReason" NOT NULL,
  source_event_id VARCHAR(256),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
