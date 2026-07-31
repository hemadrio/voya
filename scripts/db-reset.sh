#!/usr/bin/env bash
# db-reset.sh — drop schema, re-run all migrations, then seed with synthetic data.
#
# Safety: this script REFUSES to run if the DATABASE_URL target host is not on
# the explicit allow-list of local and staging hosts. It fails CLOSED on any
# ambiguity — if the host cannot be parsed, the script exits non-zero.
#
# Allow-listed hosts:
#   localhost, 127.0.0.1, 0.0.0.0  — local Docker Compose stack
#   *.staging.internal              — staging VPC internal hostnames
#   staging-travel-platform.*       — staging RDS Proxy pattern
#
# Usage:
#   ./scripts/db-reset.sh                   — reset and seed
#   DATABASE_URL=postgresql://... ./scripts/db-reset.sh
#
# The script respects the DATABASE_URL environment variable. If unset, it
# falls back to the local development default.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Default to local development connection string if DATABASE_URL is not set.
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/travel_dev?connection_limit=5&sslmode=disable}"
export DATABASE_URL

# ---------------------------------------------------------------------------
# Host allow-list guard — extract hostname and validate against allow-list.
# ---------------------------------------------------------------------------

# Extract host from the connection string (handles postgresql:// and postgres://).
# URL format: postgresql://user:pass@host:port/dbname?params
RAW_HOST=$(echo "$DATABASE_URL" | sed -E 's|^postgres(ql)?://([^:@/]+:)?([^:@/]+@)?([^/:?]+).*|\4|')

if [[ -z "$RAW_HOST" ]]; then
  echo -e "${RED}ERROR: db-reset: could not parse host from DATABASE_URL.${NC}" >&2
  echo "DATABASE_URL must be a valid postgresql:// or postgres:// URL." >&2
  exit 1
fi

ALLOWED=false
ALLOWED_PATTERNS=(
  "^localhost$"
  "^127\.0\.0\.1$"
  "^0\.0\.0\.0$"
  "^postgres$"          # Docker Compose service name
  "\.staging\.internal$"
  "^staging-travel-platform\."
)

for pattern in "${ALLOWED_PATTERNS[@]}"; do
  if echo "$RAW_HOST" | grep -qE "$pattern"; then
    ALLOWED=true
    break
  fi
done

if [[ "$ALLOWED" != "true" ]]; then
  echo -e "${RED}ERROR: db-reset: target host '$RAW_HOST' is not on the allow-list.${NC}" >&2
  echo "" >&2
  echo "This script refuses to reset any database that is not a known local or" >&2
  echo "staging host. The allow-list is hard-coded in scripts/db-reset.sh." >&2
  echo "" >&2
  echo "Allow-listed patterns:" >&2
  for p in "${ALLOWED_PATTERNS[@]}"; do
    echo "  $p" >&2
  done
  echo "" >&2
  echo "If you are targeting a legitimate staging host, add it to the" >&2
  echo "ALLOWED_PATTERNS array in scripts/db-reset.sh and commit the change." >&2
  exit 1
fi

echo -e "${YELLOW}db-reset: target host '${RAW_HOST}' is allow-listed. Proceeding...${NC}"

# ---------------------------------------------------------------------------
# Step 1: Drop the schema (Prisma migrate reset --force handles this)
# ---------------------------------------------------------------------------

echo "[db-reset] Resetting database schema..."
npx prisma migrate reset --force --skip-seed

# ---------------------------------------------------------------------------
# Step 2: Apply all migrations to rebuild the schema
# ---------------------------------------------------------------------------
# migrate reset already runs migrations; this is a no-op if reset succeeded,
# but run it explicitly to surface any migration errors before seeding.

echo "[db-reset] Running migrations..."
npx prisma migrate deploy

# ---------------------------------------------------------------------------
# Step 3: Run the deterministic synthetic seed
# ---------------------------------------------------------------------------

echo "[db-reset] Seeding with synthetic data..."
tsx prisma/seed.ts

echo -e "${GREEN}db-reset: complete. Database is ready with synthetic seed data.${NC}"
