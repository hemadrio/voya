-- Destructive fixture: DROP TABLE
-- The linter must reject this unless prisma/expand-registry.yaml contains
-- a matching entry for the legacy_sessions table.

DROP TABLE IF EXISTS legacy_sessions;
