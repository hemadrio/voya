-- Migration: 0014_offer_snapshot
-- WO-039: PENDING booking with immutable offer snapshot.
--
-- Changes (expand phase — additive only):
--   1. Add offer_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb to bookings.
--      The default is intentionally kept for the expand phase so the previous
--      service version can boot against the new schema. It will be dropped in
--      a future contract-phase migration once all rows carry a real snapshot.
--
-- The partial index on (status, expires_at) WHERE status = 'PENDING' and the
-- provenance / bookable / expires_at columns were added in earlier migrations
-- (0006_concurrent_indexes and the WO-072/WO-077 schema patches) so they are
-- not repeated here.

-- Expand phase: add offer_snapshot with a default so any existing rows remain
-- valid when this migration runs before the new service version is deployed.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS offer_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Comment for reviewers: drop the default in the contract phase:
--   ALTER TABLE bookings ALTER COLUMN offer_snapshot DROP DEFAULT;
