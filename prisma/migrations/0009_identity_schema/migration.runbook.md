# Migration 0009: Identity Schema

## Summary

Introduces the foundational identity tables that all authentication and
authorization features depend on.

## Changes

| Object | Type | Change |
|---|---|---|
| `UserStatus` enum | New | `active`, `pending`, `suspended`, `deleted` |
| `CredentialType` enum | New | `password`, `oauth`, `totp` |
| `users.email_verified_at` | New column | Nullable TIMESTAMPTZ |
| `users.display_name` | New column | Nullable VARCHAR(128) |
| `users.status` | New column | UserStatus NOT NULL DEFAULT 'pending' |
| `uq_users_lower_email` | New index | Unique functional index on `lower(email)` |
| `credentials` | New table | Secret isolation: password hashes separated from profile |
| `sessions.rotated_from_session_id` | New column | Nullable FK self-reference for rotation chain |
| `roles` | New table | Named authorization roles |
| `permissions` | New table | Named resource-action permissions |
| `role_permissions` | New join table | Many-to-many roles ↔ permissions |
| `user_roles` | New join table | Many-to-many users ↔ roles |

## Security Notes

- `credentials.secret_hash` stores only the output of a password hashing
  algorithm (e.g. Argon2id). Raw passwords must never be written here.
- Repository `select` lists must never include `secret_hash` unless the
  caller explicitly requests it for password verification.
- The functional unique index `uq_users_lower_email` prevents two accounts
  with emails differing only by case, even if the application layer fails to
  normalize before insert.

## Apply

```bash
psql "$DATABASE_URL" -f prisma/migrations/0009_identity_schema/migration.sql
```

## Rollback

```bash
psql "$DATABASE_URL" -f prisma/migrations/0009_identity_schema/migration.down.sql
```

The rollback drops all new tables, columns, indexes and enum types.  It is
safe to run when the new tables contain data (DROP TABLE CASCADE handles FK
cleanup), and idempotent when called on a database that never ran the forward
migration (all statements are `IF EXISTS`).

## Verification Queries

```sql
-- Confirm enum types exist
SELECT typname FROM pg_type WHERE typname IN ('UserStatus', 'CredentialType');

-- Confirm new columns on users
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_name = 'users'
  AND  column_name IN ('email_verified_at', 'display_name', 'status');

-- Confirm functional unique index
SELECT indexname FROM pg_indexes
WHERE  tablename = 'users' AND indexname = 'uq_users_lower_email';

-- Confirm all new tables
SELECT tablename FROM pg_tables
WHERE  schemaname = 'public'
  AND  tablename IN ('credentials', 'roles', 'permissions', 'role_permissions', 'user_roles');
```
