#!/usr/bin/env bash
# Pipeline guard: fail the build if any .env or credential-bearing file is staged.
#
# Run as a pre-commit hook or a CI step before terraform plan/apply.
# Exit code 1 if any forbidden file is found; 0 otherwise.
#
# Forbidden patterns:
#   .env, .env.*, *.env         — environment variable files
#   secrets.*, credentials.*    — credential files by common name convention
#   *.pem, *.key, *.p12, *.pfx  — private keys and certificates
#   *_rsa, *_dsa, *_ed25519     — SSH private key files
#   terraform.tfvars (non-*.tfvars.example)  — may contain literal secret values
#   .aws/credentials            — AWS credentials file

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

VIOLATIONS=()

# Check files currently tracked by git (staged + committed, not just staged)
# to catch secrets that snuck in through a prior commit in this branch.
TRACKED=$(git ls-files 2>/dev/null || true)
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
ALL_FILES=$(printf '%s\n%s\n' "$TRACKED" "$STAGED" | sort -u | grep -v '^$' || true)

check_pattern() {
  local pattern="$1"
  local description="$2"

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if [[ "$file" == $pattern ]]; then
      VIOLATIONS+=("$description: $file")
    fi
  done <<< "$ALL_FILES"
}

# .env files
check_pattern "*.env"           ".env file"
check_pattern ".env"            ".env file"
check_pattern ".env.*"          ".env variant"

# Credential/secret files by name
check_pattern "secrets.*"       "secrets file"
check_pattern "*.secrets"       "secrets file"
check_pattern "credentials.*"   "credentials file"
check_pattern "*.credentials"   "credentials file"

# Private keys and certificates
check_pattern "*.pem"           "PEM certificate/key"
check_pattern "*.key"           "private key"
check_pattern "*.p12"           "PKCS#12 keystore"
check_pattern "*.pfx"           "PFX keystore"
check_pattern "*_rsa"           "RSA private key"
check_pattern "*_dsa"           "DSA private key"
check_pattern "*_ed25519"       "Ed25519 private key"
check_pattern "*_ecdsa"         "ECDSA private key"
check_pattern "id_rsa"          "RSA private key"
check_pattern "id_dsa"          "DSA private key"
check_pattern "id_ed25519"      "Ed25519 private key"

# Terraform variable files that may contain literal secret values
check_pattern "terraform.tfvars" "terraform.tfvars (may contain secrets; use *.tfvars.example pattern)"
check_pattern "*.auto.tfvars"    "auto-loaded .tfvars file"

# AWS credentials
check_pattern ".aws/credentials" "AWS credentials file"

# Report and exit
if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  echo -e "${RED}ERROR: Credential or secret file detected in git tree:${NC}" >&2
  for v in "${VIOLATIONS[@]}"; do
    echo -e "  ${YELLOW}→ $v${NC}" >&2
  done
  echo "" >&2
  echo "Remove these files from git history, rotate any exposed secrets," >&2
  echo "and add them to .gitignore before retrying." >&2
  echo "" >&2
  echo "If a terraform.tfvars is required, use terraform.tfvars.example" >&2
  echo "with placeholder values and pass real values via TF_VAR_ environment" >&2
  echo "variables or an AWS Secrets Manager data source." >&2
  exit 1
fi

echo "check-env-files: no credential or secret files found." >&2
exit 0
