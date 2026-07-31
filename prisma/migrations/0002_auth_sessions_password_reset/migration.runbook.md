# Migration Runbook: 0002_auth_sessions_password_reset

## Summary

Additive schema changes for WO-024 (logout, session revocation, password reset).
All new columns are nullable or defaulted — previous service versions continue to
operate against the migrated schema without backfill.

## Changes

- `sessions`: adds `refresh_token_hash`, `family_id`, `revoked_at`, `ip_address`,
  `user_agent`, `last_seen_at` columns and a partial index on `(user_id, revoked_at)`.
- `users`: adds `failed_attempt_count` (default 0) and `locked_until` columns.
- New `one_time_tokens` table: stores hashed single-use tokens for password reset.
  Includes a partial index on `(user_id, purpose, consumed_at)`.

## Forward Migration

Run by the one-off ECS migration task before the new service version is deployed:

```bash
# Dry-run (review changes without applying)
psql "$DATABASE_URL" -f prisma/migrations/0002_auth_sessions_password_reset/migration.sql --set ON_ERROR_STOP=1 -v

# Apply (idempotent — safe to re-run on task retry)
psql "$DATABASE_URL" -f prisma/migrations/0002_auth_sessions_password_reset/migration.sql
```

## Rollback

This migration is additive and requires no immediate rollback step. To contract
in a future release, drop the new columns and the `one_time_tokens` table only
after all service versions no longer reference them.
