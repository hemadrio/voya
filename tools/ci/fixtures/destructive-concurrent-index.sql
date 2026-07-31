-- Destructive fixture: CREATE INDEX CONCURRENTLY
-- This cannot run inside a transaction. If it fails partway through,
-- it leaves an invalid index entry in pg_index that must be dropped manually
-- before the index can be rebuilt. The linter flags this for explicit review.

CREATE INDEX CONCURRENTLY idx_bookings_user_created
  ON bookings(user_id, created_at);
