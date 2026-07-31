-- Rollback: 0009_identity_schema
-- Drops all objects created by 0009_identity_schema/migration.sql in reverse
-- dependency order.  Safe to run against a database that has never had rows
-- in these tables (IF EXISTS guards every statement).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. RBAC tables (no external dependents)
-- ---------------------------------------------------------------------------

DROP INDEX   IF EXISTS idx_user_roles_user_id;
DROP TABLE   IF EXISTS user_roles;
DROP TABLE   IF EXISTS role_permissions;
DROP TABLE   IF EXISTS permissions;
DROP TABLE   IF EXISTS roles;

-- ---------------------------------------------------------------------------
-- 2. Credentials table
-- ---------------------------------------------------------------------------

DROP INDEX   IF EXISTS idx_credentials_user_id;
DROP TABLE   IF EXISTS credentials;

-- ---------------------------------------------------------------------------
-- 3. Sessions table: remove rotated_from_session_id
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  DROP COLUMN IF EXISTS rotated_from_session_id;

-- ---------------------------------------------------------------------------
-- 4. Users table: remove identity additions
-- ---------------------------------------------------------------------------

DROP INDEX   IF EXISTS uq_users_lower_email;

ALTER TABLE users
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS email_verified_at;

-- ---------------------------------------------------------------------------
-- 5. Enums
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS "CredentialType";
DROP TYPE IF EXISTS "UserStatus";
