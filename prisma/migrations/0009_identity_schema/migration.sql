-- Migration: 0009_identity_schema
-- Strategy: expand/contract — all changes are additive.
-- Adds identity schema: user status enum, credential type enum, credentials table,
-- RBAC tables (roles, permissions, role_permissions, user_roles), email_verified_at
-- and display_name and status columns to users, rotated_from_session_id to sessions.
-- All DDL statements use IF NOT EXISTS so this migration is idempotent when re-run.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "UserStatus" AS ENUM ('active', 'pending', 'suspended', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CredentialType" AS ENUM ('password', 'oauth', 'totp');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Users table additions
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS display_name      VARCHAR(128),
  ADD COLUMN IF NOT EXISTS status            "UserStatus" NOT NULL DEFAULT 'pending';

-- Functional unique index for case-insensitive email uniqueness.
-- Enforces uniqueness even if the application normalization is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_email ON users (lower(email));

-- ---------------------------------------------------------------------------
-- 3. Credentials table
--
-- Keeps secret material (password hashes) isolated from the frequently-read
-- users profile table so profile queries never load credential data.
-- CASCADE DELETE ensures no orphaned credentials remain after user deletion.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credentials (
  id                   UUID             NOT NULL DEFAULT gen_random_uuid(),
  user_id              UUID             NOT NULL,
  type                 "CredentialType" NOT NULL DEFAULT 'password',
  secret_hash          TEXT             NOT NULL,
  hash_algorithm       VARCHAR(32)      NOT NULL DEFAULT 'argon2id',
  failed_attempt_count INTEGER          NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_used_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),

  CONSTRAINT credentials_pkey      PRIMARY KEY (id),
  CONSTRAINT credentials_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credentials_user_id ON credentials (user_id);

-- ---------------------------------------------------------------------------
-- 4. Sessions table addition: rotated_from_session_id self-reference
--
-- Preserves the rotation chain so refresh-token reuse detection can walk the
-- chain and revoke entire families of sessions in a later story.
-- SET NULL on parent delete: a revoked ancestor does not cascade-delete the
-- child session (the child may still be valid).
-- ---------------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS rotated_from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5. Roles table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  name        VARCHAR(64) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT roles_pkey      PRIMARY KEY (id),
  CONSTRAINT uq_roles_name   UNIQUE (name)
);

-- ---------------------------------------------------------------------------
-- 6. Permissions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS permissions (
  id          UUID         NOT NULL DEFAULT gen_random_uuid(),
  name        VARCHAR(128) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT permissions_pkey    PRIMARY KEY (id),
  CONSTRAINT uq_permissions_name UNIQUE (name)
);

-- ---------------------------------------------------------------------------
-- 7. Role-permissions join table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       UUID        NOT NULL,
  permission_id UUID        NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pk_role_permissions        PRIMARY KEY (role_id, permission_id),
  CONSTRAINT role_permissions_role_fkey FOREIGN KEY (role_id)       REFERENCES roles(id)       ON DELETE CASCADE,
  CONSTRAINT role_permissions_perm_fkey FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 8. User-roles join table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     UUID        NOT NULL,
  role_id     UUID        NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pk_user_roles        PRIMARY KEY (user_id, role_id),
  CONSTRAINT user_roles_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE,
  CONSTRAINT user_roles_role_fkey FOREIGN KEY (role_id) REFERENCES roles(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles (user_id);
