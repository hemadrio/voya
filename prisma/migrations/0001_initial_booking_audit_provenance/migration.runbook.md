# Migration Runbook: 0001_initial_booking_audit_provenance

## Summary

Additive schema changes for idempotency, append-only audit, and provenance
tracking. Delivered as expand half of the expand/contract pattern — the
previous service version continues to operate against the migrated schema.

## Forward Migration

Run by the one-off ECS migration task before the new service version is deployed:

```bash
# Dry-run (review changes without applying)
psql "$DATABASE_URL" -f prisma/migrations/0001_initial_booking_audit_provenance/migration.sql --set ON_ERROR_STOP=1 -v

# Apply (idempotent — safe to re-run on task retry)
psql "$DATABASE_URL" -f prisma/migrations/0001_initial_booking_audit_provenance/migration.sql
```

## Rollback

The rollback script removes the WO-072 additive columns only. Pre-existing rows
are unaffected. Run before deploying the previous service version:

```sql
-- Remove WO-072 columns from bookings (additive rollback)
ALTER TABLE bookings DROP COLUMN IF EXISTS provenance;
ALTER TABLE bookings DROP COLUMN IF EXISTS bookable;

-- Remove WO-072 columns from booking_audit_log
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS actor_id;
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS actor_role;
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS resource_type;
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS resource_id;
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS occurred_at;
ALTER TABLE booking_audit_log DROP COLUMN IF EXISTS sequence;

-- Remove append-only trigger (the previous version does not need it)
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON booking_audit_log;
DROP FUNCTION IF EXISTS enforce_audit_log_append_only();

-- Remove processed_events table
DROP TABLE IF EXISTS processed_events;
```

## Verification Checklist

After forward migration:
- [ ] `\d bookings` shows `provenance` (varchar, nullable) and `bookable` (boolean, default false)
- [ ] `\d booking_audit_log` shows `actor_id`, `actor_role`, `resource_type`, `resource_id`, `occurred_at`, `sequence`
- [ ] `\d processed_events` shows all seven columns with unique constraint on `(provider, event_id)`
- [ ] `INSERT INTO booking_audit_log (...) VALUES (...)` succeeds
- [ ] `UPDATE booking_audit_log SET action='X' WHERE id='...'` raises `insufficient_privilege`
- [ ] `DELETE FROM booking_audit_log WHERE id='...'` raises `insufficient_privilege`
- [ ] Duplicate `INSERT INTO processed_events (provider, event_id, ...)` raises `unique_violation` (23505)
- [ ] `SELECT * FROM processed_events LIMIT 1` succeeds (SELECT still allowed)
