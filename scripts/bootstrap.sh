#!/usr/bin/env bash
# bootstrap.sh — one-command local environment setup for the travel platform.
#
# Usage:
#   ./scripts/bootstrap.sh                 # full bootstrap
#   ./scripts/bootstrap.sh --reset         # drop volumes, reseed, rebuild
#   ./scripts/bootstrap.sh --skip-seed     # skip the synthetic data seed step
#   ./scripts/bootstrap.sh --infra-only    # start Compose stack only (no install/build)
#
# What it does (each step gated on the previous succeeding):
#   1. Prerequisite check  — container runtime, Node version, pnpm version
#   2. Environment file    — create .env from .env.example if absent; diff if present
#   3. Install             — frozen-lockfile pnpm install (drifted lockfile fails)
#   4. Infrastructure      — docker compose up + wait-for-stack.sh readiness gating
#   5. Migrate             — apply pending database migrations
#   6. Seed                — run the deterministic synthetic seed
#   7. Build               — workspace build for shared packages and generated artefacts
#   8. Develop             — fan out persistent dev tasks via turbo
#
# Exit codes:
#   0 — bootstrap complete and all services running
#   1 — a step failed (failing step, error, and runbook anchor printed)
#   2 — already running (lock file held by another bootstrap invocation)
#
# Runbook: docs/local-development.md

set -euo pipefail

# ── Concurrency guard ─────────────────────────────────────────────────────────
LOCK_FILE="/tmp/travel-platform-bootstrap.lock"
SCRIPT_PID=$$

if [[ -f "${LOCK_FILE}" ]]; then
  existing_pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    echo "[BOOTSTRAP] ERROR: Another bootstrap invocation is already running (PID ${existing_pid})." >&2
    echo "[BOOTSTRAP] Wait for it to complete or kill it before retrying." >&2
    echo "[BOOTSTRAP] Runbook: docs/local-development.md#bootstrap" >&2
    exit 2
  fi
fi
echo "${SCRIPT_PID}" > "${LOCK_FILE}"

# ── Flags ─────────────────────────────────────────────────────────────────────
RESET=false
SKIP_SEED=false
INFRA_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --reset)      RESET=true ;;
    --skip-seed)  SKIP_SEED=true ;;
    --infra-only) INFRA_ONLY=true ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# //' | head -20
      exit 0
      ;;
  esac
done

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

step()    { echo -e "\n${BLUE}[BOOTSTRAP]${NC} ── ${*} ──"; }
ok()      { echo -e "${GREEN}[OK]${NC}   ${*}"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} ${*}"; }
fail()    {
  echo -e "${RED}[FAIL]${NC} ${*}" >&2
  echo -e "${RED}[FAIL]${NC} Runbook: docs/local-development.md#troubleshooting" >&2
}

# ── Trap: print context on unexpected failure ─────────────────────────────────
CURRENT_STEP="(starting)"

abort_trap() {
  local exit_code=$?
  fail "Bootstrap aborted during step: ${CURRENT_STEP}"
  fail "Exit code: ${exit_code}"
  fail "Check the output above for the underlying error."
  fail "To retry from scratch: ./scripts/bootstrap.sh --reset"
  rm -f "${LOCK_FILE}"
  exit 1
}

trap abort_trap ERR
trap 'rm -f "${LOCK_FILE}"' EXIT

# ── Required versions (must match package.json engines and packageManager) ─────
REQUIRED_NODE_MAJOR=20
REQUIRED_PNPM_MAJOR=9

# ── Step 1: Prerequisite checks ───────────────────────────────────────────────
CURRENT_STEP="prerequisite checks"
step "Step 1: Prerequisite checks"

# Container runtime
if ! docker info &>/dev/null; then
  fail "Container runtime is not running or not reachable."
  fail "  Expected:     Docker Desktop or Docker Engine running"
  fail "  Detected:     docker info returned non-zero"
  fail "  Remediation:  Start Docker Desktop or run: sudo systemctl start docker"
  exit 1
fi
ok "Container runtime is running"

# Node.js version
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed."
  fail "  Remediation:  Install Node.js ${REQUIRED_NODE_MAJOR} via nvm: nvm install ${REQUIRED_NODE_MAJOR}"
  exit 1
fi
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "${NODE_MAJOR}" -ne "${REQUIRED_NODE_MAJOR}" ]]; then
  fail "Node.js version mismatch."
  fail "  Expected:     v${REQUIRED_NODE_MAJOR}.x"
  fail "  Detected:     $(node --version)"
  fail "  Remediation:  nvm install ${REQUIRED_NODE_MAJOR} && nvm use ${REQUIRED_NODE_MAJOR}"
  exit 1
fi
ok "Node.js $(node --version) (major ${NODE_MAJOR} matches requirement)"

# pnpm version
if ! command -v pnpm &>/dev/null; then
  fail "pnpm is not installed."
  fail "  Expected:     pnpm ${REQUIRED_PNPM_MAJOR}.x"
  fail "  Remediation:  npm install -g pnpm@${REQUIRED_PNPM_MAJOR} OR corepack enable && corepack use pnpm@${REQUIRED_PNPM_MAJOR}"
  exit 1
fi
PNPM_MAJOR=$(pnpm --version | cut -d. -f1)
if [[ "${PNPM_MAJOR}" -ne "${REQUIRED_PNPM_MAJOR}" ]]; then
  fail "pnpm version mismatch."
  fail "  Expected:     ${REQUIRED_PNPM_MAJOR}.x"
  fail "  Detected:     $(pnpm --version)"
  fail "  Remediation:  corepack enable && corepack use pnpm@${REQUIRED_PNPM_MAJOR}"
  exit 1
fi
ok "pnpm $(pnpm --version) (major ${PNPM_MAJOR} matches requirement)"

if [[ "${INFRA_ONLY}" == "true" ]]; then
  # Skip to Step 4
  :
else

# ── Step 2: Environment file ──────────────────────────────────────────────────
CURRENT_STEP="environment file"
step "Step 2: Environment file"

ENV_FILE=".env"
TEMPLATE_FILE=".env.example"

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
  fail "Environment template not found: ${TEMPLATE_FILE}"
  fail "  This file should be committed to the repository."
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${TEMPLATE_FILE}" "${ENV_FILE}"
  ok "Created ${ENV_FILE} from ${TEMPLATE_FILE}"
  warn "Review ${ENV_FILE} and replace placeholder values before running services."
else
  ok "${ENV_FILE} already exists — checking for drift against ${TEMPLATE_FILE}"

  # Keys in template but missing from .env
  missing_keys=()
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    [[ -z "$key" ]] && continue
    if ! grep -qE "^${key}=" "${ENV_FILE}" 2>/dev/null; then
      missing_keys+=("${key}")
    fi
  done < "${TEMPLATE_FILE}"

  # Keys in .env not present in template (informational only)
  unknown_keys=()
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    [[ -z "$key" ]] && continue
    if ! grep -qE "^${key}=" "${TEMPLATE_FILE}" 2>/dev/null; then
      unknown_keys+=("${key}")
    fi
  done < "${ENV_FILE}"

  if [[ ${#missing_keys[@]} -gt 0 ]]; then
    warn "Keys in ${TEMPLATE_FILE} missing from your ${ENV_FILE}:"
    for k in "${missing_keys[@]}"; do
      warn "  + ${k}"
    done
    warn "Add these to ${ENV_FILE} to avoid startup failures."
  fi

  if [[ ${#unknown_keys[@]} -gt 0 ]]; then
    ok "Informational: ${ENV_FILE} contains ${#unknown_keys[@]} key(s) not in the template (possibly service-specific overrides):"
    for k in "${unknown_keys[@]}"; do
      ok "  ? ${k}"
    done
  fi

  if [[ ${#missing_keys[@]} -eq 0 ]] && [[ ${#unknown_keys[@]} -eq 0 ]]; then
    ok "No drift detected between ${ENV_FILE} and ${TEMPLATE_FILE}"
  fi
fi

# ── Step 3: Install (frozen lockfile) ─────────────────────────────────────────
CURRENT_STEP="frozen-lockfile install"
step "Step 3: Install (frozen lockfile)"

if ! pnpm install --frozen-lockfile 2>&1; then
  fail "pnpm install --frozen-lockfile failed."
  fail "  This usually means pnpm-lock.yaml is out of sync with package.json."
  fail "  If you intentionally added a dependency, run: pnpm install"
  fail "  and commit the updated lockfile. Never resolve silently in CI."
  exit 1
fi
ok "Dependencies installed (lockfile verified)"

fi  # end of non-infra-only block

# ── Step 4: Infrastructure (Compose + readiness gating) ──────────────────────
CURRENT_STEP="compose infrastructure"
step "Step 4: Infrastructure (docker compose)"

if [[ "${RESET}" == "true" ]]; then
  warn "Reset flag set — dropping Compose volumes and recreating containers"
  docker compose down -v --remove-orphans 2>&1 || true
fi

docker compose up -d 2>&1
ok "Compose services started"

step "Step 4 (cont): Waiting for dependency readiness"
./scripts/wait-for-stack.sh
ok "All infrastructure dependencies are healthy"

if [[ "${INFRA_ONLY}" == "true" ]]; then
  ok "Bootstrap complete (--infra-only). Services: $(docker compose ps --services | tr '\n' ' ')"
  exit 0
fi

# ── Step 5: Migrate ───────────────────────────────────────────────────────────
CURRENT_STEP="database migration"
step "Step 5: Database migration"

if ! pnpm --filter @travel/db-migrate db:migrate 2>&1; then
  # Fallback: attempt migration via prisma migrate deploy if db-migrate filter unavailable
  if ! npx prisma migrate deploy 2>&1; then
    fail "Database migration failed."
    fail "  If the Compose stack is still starting, wait and retry: ./scripts/bootstrap.sh --skip-seed"
    fail "  If the schema is out of date, check prisma/migrations/ for pending files."
    fail "  Runbook: docs/local-development.md#database-reset"
    exit 1
  fi
fi
ok "Database migrations applied"

# ── Step 6: Seed ──────────────────────────────────────────────────────────────
CURRENT_STEP="synthetic seed"
step "Step 6: Synthetic data seed"

if [[ "${SKIP_SEED}" == "true" ]]; then
  warn "Skipping seed (--skip-seed flag set)"
else
  if ! pnpm db:seed 2>&1; then
    fail "Seed failed."
    fail "  If this is a reset, ensure migrations ran first."
    fail "  To retry without reseed: ./scripts/bootstrap.sh --skip-seed"
    exit 1
  fi
  ok "Synthetic data seeded"
fi

# ── Step 7: Build ─────────────────────────────────────────────────────────────
CURRENT_STEP="workspace build"
step "Step 7: Workspace build"

if ! pnpm build 2>&1; then
  fail "Workspace build failed."
  fail "  Check the Turborepo output above for the failing package."
  fail "  Common causes: TypeScript errors, missing generated artefacts."
  exit 1
fi
ok "All packages built"

# ── Step 8: Develop ───────────────────────────────────────────────────────────
CURRENT_STEP="development fan-out"
step "Step 8: Starting development tasks"

ok "Bootstrap complete! Starting persistent dev watchers via turbo..."
ok ""
ok "  Services will be available at:"
ok "    Frontend:             http://localhost:3009 (or NEXT_PUBLIC port)"
ok "    API Gateway:          http://localhost:3000"
ok "    Auth service:         http://localhost:3001"
ok "    User service:         http://localhost:3002"
ok "    Flight service:       http://localhost:3003"
ok "    Hotel service:        http://localhost:3004"
ok "    Car service:          http://localhost:3005"
ok "    Booking service:      http://localhost:3006"
ok "    Payment service:      http://localhost:3007"
ok "    AI orchestration:     http://localhost:3008"
ok ""
ok "  Infrastructure:"
ok "    PostgreSQL:           localhost:5432"
ok "    Redis:                localhost:6379"
ok "    RabbitMQ:             localhost:5672  (UI: http://localhost:15672)"
ok ""
ok "  Tail logs:     docker compose logs -f"
ok "  Reset:         ./scripts/bootstrap.sh --reset"
ok "  Teardown:      docker compose down -v"
ok "  Runbook:       docs/local-development.md"

exec pnpm dev
