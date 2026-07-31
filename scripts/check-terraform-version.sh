#!/usr/bin/env bash
# check-terraform-version.sh — fail CI if the installed Terraform CLI version
# is outside the ~> 1.15 constraint required by infra/terraform/modules/network/versions.tf
#
# Usage: ./scripts/check-terraform-version.sh
# Exit: 0 = version is compatible, 1 = version is incompatible or terraform not found.

set -euo pipefail

REQUIRED_MAJOR=1
REQUIRED_MINOR=15

command -v terraform >/dev/null 2>&1 || {
  echo "ERROR: terraform CLI not found in PATH." >&2
  exit 1
}

RAW_VERSION=$(terraform version -json 2>/dev/null | grep -o '"terraform_version":"[^"]*"' | head -1 | sed 's/"terraform_version":"//;s/"//')

if [[ -z "$RAW_VERSION" ]]; then
  # Fallback for older terraform version output format
  RAW_VERSION=$(terraform version 2>/dev/null | head -1 | sed 's/Terraform v//')
fi

if [[ -z "$RAW_VERSION" ]]; then
  echo "ERROR: Could not determine Terraform version." >&2
  exit 1
fi

# Extract major and minor version numbers
MAJOR=$(echo "$RAW_VERSION" | cut -d. -f1)
MINOR=$(echo "$RAW_VERSION" | cut -d. -f2)

echo "Detected Terraform version: $RAW_VERSION (major=$MAJOR, minor=$MINOR)"
echo "Required constraint: ~> 1.15 (major=1, minor>=15, minor<2)"

if [[ "$MAJOR" -ne "$REQUIRED_MAJOR" ]]; then
  echo "ERROR: Terraform major version must be $REQUIRED_MAJOR, got $MAJOR." >&2
  echo "       The ~> 1.15 constraint prevents major version upgrades (no Terraform 2.x)." >&2
  exit 1
fi

if [[ "$MINOR" -lt "$REQUIRED_MINOR" ]]; then
  echo "ERROR: Terraform minor version must be >= $REQUIRED_MINOR, got $MINOR." >&2
  echo "       Upgrade to Terraform 1.$REQUIRED_MINOR or later: https://releases.hashicorp.com/terraform/" >&2
  exit 1
fi

echo "OK: Terraform $RAW_VERSION satisfies the ~> 1.15 constraint."
