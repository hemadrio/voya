-- Safe fixture: ADD COLUMN (nullable / with DEFAULT)
-- Both forms are safe: nullable columns can be added without backfill, and
-- columns with a constant DEFAULT are applied by PostgreSQL without a full
-- table rewrite (since Postgres 11).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
