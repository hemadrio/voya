#!/usr/bin/env bash
# wait-for-stack.sh — block until all local infrastructure containers are healthy,
# then run a protocol-level probe against each dependency.
#
# Usage:
#   ./scripts/wait-for-stack.sh           # waits for postgres + redis + rabbitmq
#   ./scripts/wait-for-stack.sh --aws     # also waits for localstack
#
# Exit codes:
#   0 — all dependencies healthy and accepting connections
#   1 — one or more dependencies failed within the timeout
#
# The script never uses sleep-and-hope. It polls Docker health status, then
# performs a protocol-level probe (SQL SELECT 1, Redis PING, AMQP check_running).
# On timeout it prints the last 20 log lines and health output for each failing
# container so the developer can diagnose immediately.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
OVERALL_TIMEOUT="${WAIT_TIMEOUT:-120}"    # seconds to wait for all deps
POLL_INTERVAL=3                           # seconds between health polls
CONTAINERS=(travel-postgres travel-redis travel-rabbitmq)
WITH_AWS=false

for arg in "$@"; do
  [[ "$arg" == "--aws" ]] && WITH_AWS=true
done

if [[ "$WITH_AWS" == "true" ]]; then
  CONTAINERS+=(travel-localstack)
fi

# ── Colour output ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WAIT]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# ── Helpers ───────────────────────────────────────────────────────────────────

container_health() {
  docker inspect --format='{{.State.Health.Status}}' "$1" 2>/dev/null || echo "missing"
}

dump_diagnostics() {
  local container="$1"
  fail "=== Diagnostics for ${container} ==="
  echo "--- Last health output ---" >&2
  docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' "${container}" 2>/dev/null >&2 || true
  echo "--- Last 20 log lines ---" >&2
  docker logs --tail 20 "${container}" 2>&1 >&2 || true
}

probe_postgres() {
  docker exec travel-postgres \
    psql -U postgres -d travel_dev -c "SELECT 1" -q --no-align -t 2>/dev/null | grep -q "1"
}

probe_redis() {
  docker exec travel-redis redis-cli ping 2>/dev/null | grep -q "PONG"
}

probe_rabbitmq() {
  docker exec travel-rabbitmq rabbitmq-diagnostics check_running 2>/dev/null
}

probe_localstack() {
  docker exec travel-localstack \
    awslocal sqs list-queues --region eu-west-1 >/dev/null 2>&1
}

run_probe() {
  local container="$1"
  case "$container" in
    travel-postgres)   probe_postgres   ;;
    travel-redis)      probe_redis      ;;
    travel-rabbitmq)   probe_rabbitmq   ;;
    travel-localstack) probe_localstack ;;
  esac
}

# ── Main wait loop ─────────────────────────────────────────────────────────────

echo "Waiting for containers to become healthy (timeout: ${OVERALL_TIMEOUT}s)..."
echo "Containers: ${CONTAINERS[*]}"
echo ""

start_time=$(date +%s)
failed_containers=()

while true; do
  all_healthy=true
  failed_containers=()
  elapsed=$(( $(date +%s) - start_time ))

  if (( elapsed >= OVERALL_TIMEOUT )); then
    fail "Timeout after ${OVERALL_TIMEOUT}s waiting for containers to become healthy."
    for c in "${CONTAINERS[@]}"; do
      status=$(container_health "$c")
      if [[ "$status" != "healthy" ]]; then
        dump_diagnostics "$c"
        failed_containers+=("$c")
      fi
    done
    exit 1
  fi

  for container in "${CONTAINERS[@]}"; do
    status=$(container_health "$container")
    if [[ "$status" == "healthy" ]]; then
      : # already healthy
    elif [[ "$status" == "missing" ]]; then
      warn "${container}: not running (is the stack started?)"
      all_healthy=false
      failed_containers+=("$container")
    else
      warn "${container}: ${status} (${elapsed}s elapsed)"
      all_healthy=false
    fi
  done

  if [[ "$all_healthy" == "true" ]]; then
    break
  fi

  sleep "${POLL_INTERVAL}"
done

echo ""
echo "All containers healthy. Running protocol-level probes..."
echo ""

all_probes_passed=true
for container in "${CONTAINERS[@]}"; do
  if run_probe "$container"; then
    ok "${container}: protocol probe passed"
  else
    fail "${container}: container is healthy but protocol probe FAILED"
    dump_diagnostics "$container"
    all_probes_passed=false
  fi
done

echo ""
if [[ "$all_probes_passed" == "true" ]]; then
  ok "All dependencies healthy and accepting connections."

  # Print connection strings for convenience
  echo ""
  echo "Connection strings:"
  echo "  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable"
  echo "  REDIS_URL=redis://localhost:6379"
  echo "  RABBITMQ_URL=amqp://guest:guest@localhost:5672/"
  if [[ "$WITH_AWS" == "true" ]]; then
    echo "  AWS_ENDPOINT_URL=http://localhost:4566"
  fi
  exit 0
else
  fail "One or more protocol probes failed. See diagnostics above."
  exit 1
fi
