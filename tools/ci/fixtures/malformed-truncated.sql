-- Malformed fixture: truncated / incomplete SQL
-- The linter must handle this gracefully without throwing.
-- This simulates a file that was partially written or corrupted.

ALTER TABLE bookings ADD COLUMN
