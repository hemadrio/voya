#!/usr/bin/env bash
# verify-signature.sh — Cosign image signature verification wrapper (WO-085).
#
# Iterates over all service images for the current build SHA and verifies each
# has a valid cosign signature from the KMS-backed key. Any image that fails
# verification causes the script to exit non-zero immediately — unsigned or
# tamper-modified images are never deployed.
#
# Preconditions (enforced by the deploy stage):
#   COSIGN_PUBLIC_KEY — cosign public key material (injected from CI secrets)
#   REGISTRY          — container registry base URL (default: registry.forge.internal)
#
# Usage:
#   tools/ci/verify-signature.sh [--sha <gitsha>] [--registry <url>]
#
# Exit codes:
#   0 — all service images verified
#   1 — one or more images failed verification or missing
#   2 — usage / configuration error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────

REGISTRY="${REGISTRY:-registry.forge.internal}"
GIT_SHA=""
FAIL_FAST=1

# ── Argument parsing ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      GIT_SHA="$2"
      shift 2
      ;;
    --registry)
      REGISTRY="$2"
      shift 2
      ;;
    --no-fail-fast)
      FAIL_FAST=0
      shift
      ;;
    *)
      echo "[verify-signature] ERROR: Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ── Resolve git SHA ───────────────────────────────────────────────────────────

if [[ -z "${GIT_SHA}" ]]; then
  GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || true)"
fi

if [[ -z "${GIT_SHA}" ]]; then
  echo "[verify-signature] ERROR: Could not resolve git SHA. Pass --sha or run inside a git repository." >&2
  exit 2
fi

# ── Verify cosign public key is available ─────────────────────────────────────

if [[ -z "${COSIGN_PUBLIC_KEY:-}" ]]; then
  echo "[verify-signature] ERROR: COSIGN_PUBLIC_KEY environment variable is not set." >&2
  echo "  This variable must be injected by the CI runner from the secrets store." >&2
  echo "  KMS key unavailability must fail the stage closed — signing cannot be skipped." >&2
  exit 2
fi

# ── Verification loop ─────────────────────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0
FAILED_IMAGES=()

for service_dir in "${REPO_ROOT}"/services/*/; do
  service="$(basename "${service_dir}")"

  # Compute tag using the same logic as image-tag.ts
  # Format: <service>-<sha>  (matches image-tag.ts output)
  tag="${service}-${GIT_SHA}"
  image="${REGISTRY}/${tag}"

  echo "[verify-signature] Verifying: ${image}"

  if cosign verify \
      --key env://COSIGN_PUBLIC_KEY \
      "${image}" \
      2>&1; then
    echo "[verify-signature] PASS: ${image}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[verify-signature] FAIL: ${image} — signature verification failed" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_IMAGES+=("${image}")

    if [[ "${FAIL_FAST}" -eq 1 ]]; then
      echo "[verify-signature] Aborting after first failure (fail-fast mode)." >&2
      exit 1
    fi
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "[verify-signature] Summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed."

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  echo "[verify-signature] FAIL — the following images could not be verified:" >&2
  for img in "${FAILED_IMAGES[@]}"; do
    echo "  ✗  ${img}" >&2
  done
  echo "" >&2
  echo "  Unsigned or tamper-modified images are rejected at deploy time (A08)." >&2
  echo "  If this is a fresh build, ensure the push:sign stage completed successfully." >&2
  exit 1
fi

echo "[verify-signature] All images verified successfully."
exit 0
