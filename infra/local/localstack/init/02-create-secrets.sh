#!/usr/bin/env bash
# LocalStack init — create Secrets Manager entries with development placeholders.
# Executed automatically after LocalStack reaches ready state.
#
# SECURITY: ALL values here are development-only placeholders.
# No real API keys, passwords, or supplier credentials may appear in this file.

set -euo pipefail

REGION="eu-west-1"
AWS_CMD="awslocal"

echo "[localstack-init] Creating Secrets Manager placeholder entries..."

create_secret() {
  local name="$1"
  local value="$2"
  ${AWS_CMD} secretsmanager create-secret \
    --name "${name}" \
    --secret-string "${value}" \
    --region "${REGION}" 2>/dev/null \
    || ${AWS_CMD} secretsmanager update-secret \
      --secret-id "${name}" \
      --secret-string "${value}" \
      --region "${REGION}"
  echo "[localstack-init] ${name} OK"
}

# JWT signing key (placeholder RS256 key — NOT a real key)
create_secret "dev/travel-platform/jwt-signing-key" \
  '{"privateKey":"LOCAL_DEV_PLACEHOLDER_NOT_A_REAL_KEY","algorithm":"RS256"}'

# Database URL (points to local postgres container)
create_secret "dev/travel-platform/db-url" \
  'postgresql://postgres:postgres@postgres:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable'

# Amadeus (placeholder)
create_secret "dev/travel-platform/amadeus-client-id"     '"LOCAL_DEV_AMADEUS_CLIENT_ID"'
create_secret "dev/travel-platform/amadeus-client-secret" '"LOCAL_DEV_AMADEUS_CLIENT_SECRET"'

# RapidAPI (placeholder)
create_secret "dev/travel-platform/rapidapi-key" '"LOCAL_DEV_RAPIDAPI_KEY"'

# Stripe (placeholder test key format)
create_secret "dev/travel-platform/stripe-secret-key"      '"sk_test_LOCAL_DEV_PLACEHOLDER"'
create_secret "dev/travel-platform/stripe-webhook-secret"  '"whsec_LOCAL_DEV_PLACEHOLDER"'

# Redis auth token (no auth in local Redis, but secret must exist)
create_secret "dev/travel-platform/redis-auth-token" '"LOCAL_DEV_NO_AUTH"'

# Anthropic (placeholder)
create_secret "dev/travel-platform/anthropic-key" '"LOCAL_DEV_ANTHROPIC_KEY"'

echo "[localstack-init] Secrets Manager entries created."
${AWS_CMD} secretsmanager list-secrets --region "${REGION}" --query 'SecretList[].Name'
