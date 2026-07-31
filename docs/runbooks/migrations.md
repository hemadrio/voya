# Database Migration Runbook

**Scope:** Prisma schema migrations for the travel-platform monorepo.
**Audience:** Platform engineers, SREs, on-call engineers.
**Related:** [WO-086 expand-contract gate](../../prisma/expand-registry.yaml), [connection governance](connection-governance.md)

---

## Core Principle: Forward-Only, Expand-Contract

**Down migrations are not used.** Recovery from a bad migration is achieved by:

1. Re-pointing ECS services to the previous task-definition revision (see [Rollback via task definition](#rollback-via-task-definition-revision)).
2. The schema remains in the expanded state (old + new shapes co-existing), which is backward compatible with the rolled-back service code.

This is safe because the expand-contract pattern guarantees the schema is always in a state that the *previous* release's code can tolerate for the duration of one release cycle.

---

## Expand-Contract Pattern

Every destructive schema change (DROP COLUMN, DROP TABLE, RENAME COLUMN, type narrowing, NOT NULL without DEFAULT) must follow a two-release sequence:

### Phase 1 — Expand (current release)

Add the *new* shape alongside the *old* shape. Neither is removed. Both old and new code can run against the schema.

**Example:** Renaming `users.email_address` → `users.email`

```sql
-- Expand migration: add new column, copy data, keep old column
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
UPDATE users SET email = email_address WHERE email IS NULL;
```

Record the change in `prisma/expand-registry.yaml`:

```yaml
entries:
  - change_id: "users-email-rename-2024-q3"
    table: "users"
    column: "email_address"
    expand_release: "v1.5.0"           # the tag cut from this commit
    description: "Rename email_address to email."
```

Deploy and verify: old and new service code both work.

### Phase 2 — Contract (next release)

Remove the old shape. This is only safe because the previous release's code is gone.

```sql
-- Contract migration: drop the old column
ALTER TABLE users DROP COLUMN email_address;
```

The migration linter (`tools/ci/migration-lint.ts`) will permit this DROP COLUMN because `prisma/expand-registry.yaml` contains a matching entry for `users.email_address`. Update the entry with `contract_release`:

```yaml
    contract_release: "v1.6.0"
```

---

## Migration Pipeline

Every release runs the following sequence before service rollout:

```
migration:lint  →  migration:compat-gate  →  migrate  →  deploy (services)
```

| Step | What it does | Failure action |
|---|---|---|
| `migration:lint` | Classifies new migration SQL; blocks on destructive DDL without expand entry | Pipeline fails; no migration runs |
| `migration:compat-gate` | Ephemeral Postgres + previous-release contract tests | Pipeline fails; no migration runs |
| `migrate` | ECS RunTask → `prisma migrate deploy` | Pipeline fails; deploy blocked |
| `deploy` | Rolling ECS service update | Normal service rollout |

---

## DDL Privilege Model

| Role | Privileges | How granted |
|---|---|---|
| `migration_task` (PostgreSQL) | Full DDL + DML | Schema owner; runs migrations |
| `booking_svc`, `auth_svc`, etc. | DML only (SELECT, INSERT, UPDATE, DELETE) | `migration 0011_dml_only_role_grants` |

**The migration ECS task role** (`${environment}-migration-runner-task`) is the only AWS IAM principal with `rds-db:connect` as `migration_task`. Service task roles connect as their per-service DML-only roles.

**Negative test proof:** The CI compat-gate runs with `app.run_ddl_negative_test=1` which causes `migration 0011_dml_only_role_grants` to verify that service roles are denied `CREATE TABLE`. This runs in ephemeral CI Postgres only — never in production.

---

## Running a Migration Manually

Use this procedure for emergency out-of-band migrations only. All production changes should go through the pipeline.

```bash
# 1. Assume the migration task role (not your personal credentials)
CREDS=$(aws sts assume-role \
  --role-arn arn:aws:iam::123456789012:role/production-migration-runner-task \
  --role-session-name emergency-migration-$(date +%s) \
  --query 'Credentials' --output json)

# 2. Resolve the RDS Proxy endpoint
PROXY_ENDPOINT=$(aws rds describe-db-proxies \
  --query 'DBProxies[?DBProxyName==`production-travel-platform`].Endpoint' \
  --output text)

# 3. Generate an IAM auth token (valid 15 min)
DB_TOKEN=$(aws rds generate-db-auth-token \
  --hostname "${PROXY_ENDPOINT}" \
  --port 5432 \
  --region us-east-1 \
  --username migration_task)

# 4. Run migration with the privileged token
DATABASE_URL="postgresql://migration_task:${DB_TOKEN}@${PROXY_ENDPOINT}:5432/travel_platform?sslmode=require" \
  npx prisma migrate deploy --schema=prisma/schema.prisma
```

---

## Rollback via Task-Definition Revision

ECS does not roll back schema changes — the schema is always forward. To roll back service *code* after a failed deployment:

```bash
# List recent task definition revisions
aws ecs list-task-definitions \
  --family-prefix production-booking-service \
  --sort DESC --query 'taskDefinitionArns[:5]' --output table

# Update the service to point to the previous revision
aws ecs update-service \
  --cluster production-travel-platform \
  --service production-booking-service \
  --task-definition production-booking-service:<previous-revision>
```

The rolled-back code will run against the *current* (post-migration) schema. This is safe only because the expand-contract pattern ensures the schema is backward compatible for one release.

**If the migration itself must be undone** (rare, emergency):

1. The destructive change was guarded by an expand entry — the old data still exists in its original form (the contract phase has not run yet).
2. Contact a senior engineer and the on-call DBA before any manual schema change.
3. Write a *new forward migration* that restores the intended state. Do NOT run SQL outside the migration system.

---

## Concurrency Guard

Two mechanisms prevent concurrent migrations:

1. **Pipeline mutex (SSM):** The `migrate` pipeline step writes an SSM Parameter (`/${environment}/migration/lock`) before launching the ECS task and deletes it on exit. A second pipeline run will fail to write the parameter and abort.

2. **Prisma advisory lock:** `prisma migrate deploy` holds a PostgreSQL advisory lock for the duration of execution. Even if two ECS tasks are launched simultaneously, the second waits at the advisory lock rather than corrupting the schema.

**To release a stuck lock manually** (e.g. after a pipeline crash):

```bash
# SSM pipeline mutex
aws ssm delete-parameter --name /production/migration/lock

# PostgreSQL advisory lock (should auto-release when the connection closes)
# Check for held advisory locks:
psql -c "SELECT pid, pg_advisory_unlock_all() FROM pg_stat_activity WHERE application_name = 'prisma-migrate';"
```

---

## Long-Running Migrations

Migrations exceeding the pipeline step timeout (default: 30 minutes, controlled by `MIGRATION_TIMEOUT_MINUTES`) are detected and the ECS task is stopped. The pipeline aborts with an error — the deploy does not proceed.

**`CREATE INDEX CONCURRENTLY`** is flagged by the migration linter because:
- It cannot run inside a transaction
- If it fails partway, it leaves an **invalid index** in `pg_index`
- The invalid index must be dropped before the migration can be retried

Recovery from a failed `CREATE INDEX CONCURRENTLY`:

```sql
-- Find invalid indexes
SELECT indexrelid::regclass AS index_name, indisvalid
FROM pg_index WHERE NOT indisvalid;

-- Drop the invalid index
DROP INDEX CONCURRENTLY idx_name_that_failed;

-- Retry via a new migration (do not modify the existing migration file)
```

---

## Non-Production Environments

Non-production environments (staging, dev) run the same migration task against synthetic-data databases only (BR-18). The compat-gate uses an ephemeral Postgres with no production data — only schema structure.

Migration artefacts (task logs, compat-gate results) are archived to the CI pipeline artefacts store for 90 days as change-management evidence.

---

## Checklist for Shipping a Migration

- [ ] SQL file uses `IF NOT EXISTS` / `IF EXISTS` / `DO` blocks for idempotency
- [ ] No destructive DDL without a matching `prisma/expand-registry.yaml` entry
- [ ] `migration:lint` passes locally: `npx tsx tools/ci/migration-lint.ts`
- [ ] `migration:compat-gate` passes: `PREVIOUS_RELEASE=v1.x.x bash tools/ci/compat-gate.sh v1.x.x`
- [ ] Migration does not exceed 30-minute timeout estimate
- [ ] If `CREATE INDEX CONCURRENTLY`: noted in PR, recovery plan documented
- [ ] expand-registry entry references a git tag that exists
- [ ] `contract_release` updated in expand-registry after contract migration ships
