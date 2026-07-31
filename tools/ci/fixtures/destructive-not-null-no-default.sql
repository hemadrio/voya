-- Destructive fixture: ADD COLUMN NOT NULL without DEFAULT
-- Adding a NOT NULL column to an existing table with no DEFAULT forces
-- PostgreSQL to scan the entire table and fail if any row exists.
-- The expand phase must have added the column as nullable first, backfilled
-- it, then this migration makes it NOT NULL after the old code is gone.

ALTER TABLE bookings ADD COLUMN confirmed_at TIMESTAMPTZ NOT NULL;
