# Identity Schema

This document describes the tables, enums, and indexes that make up the
platform's user identity and session management schema, introduced in WO-018.

---

## Entity Overview

```
users
  ├── credentials (1:N — CASCADE DELETE)
  ├── sessions    (1:N)
  └── user_roles  (N:M via user_roles join table)

roles
  ├── user_roles       (N:M via user_roles join table)
  └── role_permissions (N:M via role_permissions join table)

permissions
  └── role_permissions (N:M via role_permissions join table)

sessions
  └── sessions.rotated_from_session_id (self-reference — rotation chain)
```

---

## Tables

### users

Stable identity anchor for every registered person.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | Generated before insert; stable across name / email changes |
| `email` | TEXT UNIQUE | Stored normalized (lowercase, trimmed) |
| `email_verified_at` | TIMESTAMPTZ NULL | Set on first successful email confirmation; null = unverified |
| `display_name` | VARCHAR(128) NULL | Preferred display name; null until the user sets one |
| `status` | UserStatus NOT NULL | Account lifecycle state (see enum below); default `pending` |
| `password_hash` | TEXT NOT NULL | **Legacy** — hash of the user's password (plain bcrypt). New callers should use the `credentials` table instead |
| `role` | UserRole NOT NULL | Coarse-grained authorization role (traveler, support_agent, system) |
| `failed_attempt_count` | INTEGER | **Legacy** — failure counter for LoginAttemptGuard (WO-016) |
| `locked_until` | TIMESTAMPTZ NULL | **Legacy** — account-level lockout timestamp (WO-016) |
| `created_at` | TIMESTAMPTZ | Row creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last modification timestamp |

**Indexes:**
- `uq_users_lower_email` — unique functional index on `lower(email)`; enforces case-insensitive uniqueness at the database level even if the application normalization is bypassed

---

### credentials

Isolated credential store.  Secret material (password hashes) lives here and
not in `users`, so profile queries never load secret data.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users.id | CASCADE DELETE: removing a user removes all credentials |
| `type` | CredentialType NOT NULL | `password`, `oauth`, or `totp` |
| `secret_hash` | TEXT NOT NULL | **Hash only** — raw passwords must never be stored here |
| `hash_algorithm` | VARCHAR(32) | Algorithm identifier (e.g. `argon2id`); default `argon2id` |
| `failed_attempt_count` | INTEGER | Per-credential failure counter |
| `locked_until` | TIMESTAMPTZ NULL | Per-credential lockout expiry |
| `last_used_at` | TIMESTAMPTZ NULL | Last successful verification |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Security constraints:**
- Repository `select` lists must never return `secret_hash` unless the caller explicitly opts in (e.g. for password verification).
- `secret_hash` must contain the output of an approved algorithm only. Raw plaintext passwords must never appear here.

**Indexes:**
- `idx_credentials_user_id` on `user_id`

---

### sessions

Server-side session tracking.  Enables refresh-token rotation and reuse detection.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID FK → users.id | |
| `token` | TEXT UNIQUE | **Legacy** — opaque session token (WO-001 auth patterns) |
| `refresh_token_hash` | TEXT NULL | **Hash only** — SHA-256 of the refresh token; never the raw value |
| `user_agent` | VARCHAR(512) NULL | Client user-agent string |
| `ip_address` | VARCHAR(45) NULL | IPv4 or IPv6 address of the issuing request |
| `expires_at` | TIMESTAMPTZ | Hard expiry; active lookups filter `expires_at > now()` |
| `revoked_at` | TIMESTAMPTZ NULL | Set when session is explicitly revoked; null = active |
| `rotated_from_session_id` | UUID NULL FK → sessions.id | Previous session in rotation chain; enables reuse detection |
| `created_at` | TIMESTAMPTZ | Session issuance time |

**Indexes:**
- `uq_sessions_refresh_token_hash` (partial unique on `refresh_token_hash WHERE IS NOT NULL`)
- `idx_sessions_user_revoked` on `(user_id, revoked_at)`
- `idx_sessions_expires_at`

---

### roles

Named authorization roles (e.g. `admin`, `traveler`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR(64) UNIQUE | Human-readable role name |
| `description` | TEXT NULL | |
| `created_at` | TIMESTAMPTZ | |

---

### permissions

Named resource-action permissions (e.g. `booking:cancel:own`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR(128) UNIQUE | |
| `description` | TEXT NULL | |
| `created_at` | TIMESTAMPTZ | |

---

### role_permissions

Join table: many-to-many between `roles` and `permissions`.

| Column | Type | Notes |
|---|---|---|
| `role_id` | UUID FK → roles.id CASCADE | |
| `permission_id` | UUID FK → permissions.id CASCADE | |
| `granted_at` | TIMESTAMPTZ | |

Primary key: `(role_id, permission_id)` — prevents duplicate grants.

---

### user_roles

Join table: many-to-many between `users` and `roles`.

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID FK → users.id CASCADE | |
| `role_id` | UUID FK → roles.id CASCADE | |
| `assigned_at` | TIMESTAMPTZ | |

Primary key: `(user_id, role_id)` — prevents duplicate role assignments.

**Indexes:**
- `idx_user_roles_user_id` on `user_id`

---

## Enum Types

### UserStatus

| Value | Meaning |
|---|---|
| `active` | Account is in good standing; can log in |
| `pending` | Registration is incomplete (default on create) |
| `suspended` | Account access is blocked by an operator action |
| `deleted` | Soft-deleted; data retained for audit; cannot log in |

### CredentialType

| Value | Meaning |
|---|---|
| `password` | Hashed password credential (Argon2id) |
| `oauth` | OAuth 2.0 token exchange |
| `totp` | Time-based one-time password (TOTP/FIDO) |

---

## Cascade Delete Summary

Deleting a `users` row:
- Cascades to all `credentials` rows for that user
- Cascades to all `user_roles` assignments for that user
- Does **not** cascade sessions or one_time_tokens (FK without CASCADE)

Deleting a `roles` row:
- Cascades to all `role_permissions` entries for that role
- Cascades to all `user_roles` assignments for that role

Deleting a `permissions` row:
- Cascades to all `role_permissions` entries for that permission

---

## Migration History

| Migration | Changes |
|---|---|
| 0001 | Initial users, sessions tables |
| 0002 | Session metadata, user lockout, one_time_tokens |
| 0008 | UserRole enum, security_events |
| **0009** | **UserStatus enum, CredentialType enum, credentials table, RBAC tables, functional email index, session rotation chain** |
