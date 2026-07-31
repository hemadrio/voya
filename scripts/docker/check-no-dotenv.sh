#!/usr/bin/env bash
# check-no-dotenv.sh — fail the Docker build if a .env file is present in the
# build context.
#
# Usage: add this as a RUN step early in every Dockerfile:
#   COPY scripts/docker/check-no-dotenv.sh /check-no-dotenv.sh
#   RUN /check-no-dotenv.sh
#
# The script exits 1 if any .env, .env.*, or *.env file is found under the
# working directory. This prevents credentials from accidentally being baked
# into an image via a COPY . . step.

set -euo pipefail

DOTENV_FILES=$(find . \
  \( -name ".env" -o -name ".env.*" -o -name "*.env" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.git/*" \
  2>/dev/null || true)

if [ -n "$DOTENV_FILES" ]; then
  echo "ERROR: .env file(s) found in the Docker build context:" >&2
  echo "$DOTENV_FILES" >&2
  echo "" >&2
  echo "Credentials must be supplied at runtime via AWS Secrets Manager." >&2
  echo "Remove the .env file from the build context and add it to .dockerignore." >&2
  exit 1
fi

echo "check-no-dotenv: OK — no .env files found in build context"
