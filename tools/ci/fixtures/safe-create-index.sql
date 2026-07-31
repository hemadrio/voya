-- Safe fixture: CREATE INDEX (non-concurrent)
-- Standard index creation inside a migration transaction.
-- Safe as long as the migration wraps it in BEGIN/COMMIT.

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at DESC);
