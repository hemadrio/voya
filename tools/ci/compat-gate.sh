#!/usr/bin/env bash
# compat-gate.sh — Compatibility gate for expand-contract migrations (WO-086).
#
# Spins up an ephemeral PostgreSQL container, applies ALL Prisma migrations
# (including the newest one being shipped), then runs the previously deployed
# release's @travel/contracts test suite against the migrated schema.
#
# This proves that code from the PREVIOUS release can still operate against
# the NEW schema — the core assertion of the expand-contract safety contract.
#
# Usage:
#   ./tools/ci/compat-gate.sh <previous_release_tag>
#
# Arguments:
#   previous_release_tag  Git tag of the release currently deployed to the target
#                         environment (e.g. "v1.4.2"). The gate checks out the
#                         contract tests from this tag and runs them.
#
# Environment variables:
#   POSTGRES_IMAGE        Docker image for ephemeral Postgres (default: postgres:16-alpine)
#   CONTAINER_PREFIX      Prefix for docker container name (default: compat-gate)
#   SKIP_TEARDOWN         Set to "1" to leave the Postgres container running for debugging.
#
# Exit codes:
#   0  All previous-release contract tests pass against the migrated schema.
#   1  Migration failed or contract tests failed.
#   2  Usage error or infrastructure failure.
#
# Security:
#   The ephemeral database is NEVER seeded from production data. Only synthetic
#   schema-only migrations are applied. No real PII or booking data is loaded.
#   (BR-18 constraint: non-production environments use synthetic data only.)

set -euo pipefail

PREVIOUS_RELEASE="${1:-}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-compat-gate}"
SKIP_TEARDOWN="${SKIP_TEARDOWN:-0}"

CONTAINER_NAME="${CONTAINER_PREFIX}-$$"
POSTGRES_PORT="54320"
POSTGRES_DB="compat_test"
POSTGRES_USER="compat_user"
POSTGRES_PASSWORD="compat_pass_$(date +%s)"

# Path helpers
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Validation ────────────────────────────────────────────────────────────────

if [[ -z "${PREVIOUS_RELEASE}" ]]; then
  echo "[compat-gate] ERROR: previous_release_tag argument is required." >&2
  echo "Usage: $0 <previous_release_tag>" >&2
  exit 2
fi

if ! command -v docker &>/dev/null; then
  echo "[compat-gate] ERROR: docker is required but not found in PATH." >&2
  exit 2
fi

# Verify the previous release tag exists in git
if ! git -C "${REPO_ROOT}" rev-parse --verify "refs/tags/${PREVIOUS_RELEASE}" &>/dev/null; then
  echo "[compat-gate] ERROR: git tag '${PREVIOUS_RELEASE}' does not exist in this repository." >&2
  echo "  The expand-registry.yaml entry references a release that was never tagged." >&2
  echo "  Verify the tag exists: git tag --list | grep '${PREVIOUS_RELEASE}'" >&2
  exit 1
fi

echo "[compat-gate] Previous release tag: ${PREVIOUS_RELEASE}"
echo "[compat-gate] Postgres image: ${POSTGRES_IMAGE}"
echo "[compat-gate] Container: ${CONTAINER_NAME}"

# ── Teardown on exit ──────────────────────────────────────────────────────────

cleanup() {
  local exit_code=$?
  if [[ "${SKIP_TEARDOWN}" != "1" ]]; then
    echo "[compat-gate] Cleaning up container ${CONTAINER_NAME}..."
    docker rm -f "${CONTAINER_NAME}" &>/dev/null || true
  else
    echo "[compat-gate] SKIP_TEARDOWN=1 — container ${CONTAINER_NAME} left running for debugging."
    echo "  Connect: PGPASSWORD=${POSTGRES_PASSWORD} psql -h localhost -p ${POSTGRES_PORT} -U ${POSTGRES_USER} ${POSTGRES_DB}"
  fi
  exit "${exit_code}"
}
trap cleanup EXIT

# ── Start ephemeral Postgres ──────────────────────────────────────────────────

echo "[compat-gate] Starting ephemeral PostgreSQL container..."

docker run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB="${POSTGRES_DB}" \
  -e POSTGRES_USER="${POSTGRES_USER}" \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  -p "${POSTGRES_PORT}:5432" \
  "${POSTGRES_IMAGE}" \
  postgres \
    -c "log_statement=none" \
    -c "log_min_messages=WARNING" >/dev/null

# Wait for Postgres to accept connections (max 30 seconds)
WAIT_SECONDS=0
until docker exec "${CONTAINER_NAME}" \
    pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" &>/dev/null; do
  if [[ ${WAIT_SECONDS} -ge 30 ]]; then
    echo "[compat-gate] ERROR: Postgres did not become ready within 30 seconds." >&2
    exit 2
  fi
  sleep 1
  ((WAIT_SECONDS++))
done

echo "[compat-gate] Postgres ready after ${WAIT_SECONDS}s."

# ── Apply all Prisma migrations ───────────────────────────────────────────────

DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable"
export DATABASE_URL

echo "[compat-gate] Applying Prisma migrations..."
cd "${REPO_ROOT}"

if ! npx prisma migrate deploy --schema=prisma/schema.prisma; then
  echo "[compat-gate] ERROR: Prisma migrate deploy failed." >&2
  echo "  Check migration SQL for syntax errors or conflicts." >&2
  exit 1
fi

echo "[compat-gate] Migrations applied successfully."

# ── Fetch previous release contract tests ────────────────────────────────────
# Check out packages/contracts/test from the previous release tag and run the
# test suite against the migrated schema. This proves backward compatibility.

PREV_TEST_DIR="/tmp/compat-gate-prev-${PREVIOUS_RELEASE}-$$"
mkdir -p "${PREV_TEST_DIR}"

echo "[compat-gate] Extracting contract tests from ${PREVIOUS_RELEASE}..."
git -C "${REPO_ROOT}" archive "${PREVIOUS_RELEASE}" -- packages/contracts/test | \
  tar -xC "${PREV_TEST_DIR}"

# Run the extracted contract tests. The tests connect via DATABASE_URL which
# points to our ephemeral migrated schema.
CONTRACTS_TEST_DIR="${PREV_TEST_DIR}/packages/contracts/test"

if [[ ! -d "${CONTRACTS_TEST_DIR}" ]]; then
  echo "[compat-gate] WARNING: No packages/contracts/test directory in ${PREVIOUS_RELEASE}." >&2
  echo "  This may mean the previous release predates the contract test suite." >&2
  echo "  Skipping compatibility check for ${PREVIOUS_RELEASE}." >&2
  exit 0
fi

echo "[compat-gate] Running ${PREVIOUS_RELEASE} contract tests against migrated schema..."

# Install contract test dependencies from the release
cd "${PREV_TEST_DIR}"
if ! npx vitest run --reporter=verbose 2>&1; then
  echo "" >&2
  echo "[compat-gate] FAILED: Previous release (${PREVIOUS_RELEASE}) contract tests" >&2
  echo "  failed against the newly migrated schema." >&2
  echo "  This means the migration is NOT backward compatible — rolling back" >&2
  echo "  to the previous release would cause failures." >&2
  echo "  Fix the migration to preserve backward compatibility or add a" >&2
  echo "  matching expand entry in prisma/expand-registry.yaml." >&2
  exit 1
fi

echo ""
echo "[compat-gate] PASSED: ${PREVIOUS_RELEASE} contract tests pass against migrated schema."
echo "  The migration is backward compatible — safe to proceed with rollout."
