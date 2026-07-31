-- Destructive fixture: DROP COLUMN
-- Used by migration-lint.test.ts to verify DROP_COLUMN detection.
-- The linter must reject this unless prisma/expand-registry.yaml contains
-- a matching entry for bookings.old_notes.

ALTER TABLE bookings DROP COLUMN old_notes;
