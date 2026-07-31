# Secret Inventory

All secret values shown as **REDACTED**. This document is the authoritative
inventory for SOC 2 CC6.1 and CC6.3 control evidence.

Last reviewed: 2026-07-31
Next review due: 2026-10-31

---

## Summary

| # | Slug | Owning Service | KMS Key | Rotation Cadence | Rotation Owner |
|---|------|---------------|---------|-----------------|----------------|
| 1 | `db-url` | booking-service | `secretsmanager` CMK | 90 days | Platform SRE |
| 2 | `redis-auth-token` | booking-service | `secretsmanager` CMK | 90 days | Platform SRE |
| 3 | `jwt-signing-key` | auth-service / api-gateway | `secretsmanager` CMK | 90 days | Auth team |
| 4 | `stripe-secret-key` | payment-service | `secretsmanager` CMK | 90 days | Payments team |
| 5 | `stripe-webhook-secret` | payment-service | `secretsmanager` CMK | Manual | Payments team |
| 6 | `amadeus-client-id` | search-service | `secretsmanager` CMK | 90 days | Search team |
| 7 | `amadeus-client-secret` | search-service | `secretsmanager` CMK | 90 days | Search team |
| 8 | `rapidapi-key` | search-service | `secretsmanager` CMK | 90 days | Search team |
| 9 | `anthropic-key` | ai-service | `secretsmanager` CMK | 90 days | AI team |
| 10 | `google-oauth-client-id` | auth-service | `secretsmanager` CMK | Manual | Auth team |
| 11 | `google-oauth-client-secret` | auth-service | `secretsmanager` CMK | 90 days | Auth team |

---

## Detail

### 1. `db-url`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>:<account>/staging/travel-platform/db-url` |
| Secret value | **REDACTED** |
| Format | PostgreSQL connection URL (`postgresql://user:REDACTED@host:5432/db`) |
| Owning service | booking-service, user-service, itinerary-service, reporting-service, notification-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation strategy | Rotation Lambda updates RDS user password and writes new URL |
| Rotation owner | Platform SRE |
| Classification | Restricted |

### 2. `redis-auth-token`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>:<account>/staging/travel-platform/redis-auth-token` |
| Secret value | **REDACTED** |
| Format | Opaque string AUTH token |
| Owning service | booking-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation strategy | Lambda generates new token, updates ElastiCache cluster, then writes secret |
| Rotation owner | Platform SRE |
| Classification | Restricted |

### 3. `jwt-signing-key`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/jwt-signing-key` |
| Secret value | **REDACTED** |
| Format | JSON `{"privateKeyPem":"REDACTED","publicKeyPem":"REDACTED","activatedAt":"ISO-8601","version":"v<N>"}` |
| Owning service | auth-service (signing), api-gateway (verification) |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (two-phase) |
| Rotation strategy | Phase 1: new key published as AWSCURRENT, previous retained as AWSPREVIOUS for 24 h. Phase 2: AWSPREVIOUS dropped after overlap. Services pick up via in-memory cache TTL (60 s). |
| Rotation owner | Auth team |
| Classification | Restricted |
| Special notes | Two-phase rotation with 24 h overlap ensures tokens issued before rotation remain verifiable. No coordinated restart required. |

### 4. `stripe-secret-key`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/stripe-secret-key` |
| Secret value | **REDACTED** |
| Format | `sk_live_...` (production) / `sk_test_...` (staging) |
| Owning service | payment-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation strategy | Stripe API key rotation via Stripe Dashboard; Lambda writes new value |
| Rotation owner | Payments team |
| Classification | Restricted |

### 5. `stripe-webhook-secret`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/stripe-webhook-secret` |
| Secret value | **REDACTED** |
| Format | `whsec_...` |
| Owning service | payment-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | Manual (Stripe does not support automated webhook secret rotation) |
| Rotation strategy | Manual rotation via Stripe Dashboard; engineer updates secret out-of-band |
| Rotation owner | Payments team |
| Classification | Restricted |

### 6. `amadeus-client-id`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/amadeus-client-id` |
| Secret value | **REDACTED** |
| Format | Alphanumeric OAuth2 client ID |
| Owning service | search-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation owner | Search team |
| Classification | Restricted |

### 7. `amadeus-client-secret`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/amadeus-client-secret` |
| Secret value | **REDACTED** |
| Format | Alphanumeric OAuth2 client secret |
| Owning service | search-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation owner | Search team |
| Classification | Restricted |

### 8. `rapidapi-key`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/rapidapi-key` |
| Secret value | **REDACTED** |
| Format | RapidAPI subscription key |
| Owning service | search-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation owner | Search team |
| Classification | Restricted |

### 9. `anthropic-key`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/anthropic-key` |
| Secret value | **REDACTED** |
| Format | `sk-ant-...` |
| Owning service | ai-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation owner | AI team |
| Classification | Restricted |

### 10. `google-oauth-client-id`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/google-oauth-client-id` |
| Secret value | **REDACTED** |
| Format | `<digits>-<alphanum>.apps.googleusercontent.com` |
| Owning service | auth-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | Manual (Google does not support automated OAuth client rotation) |
| Rotation owner | Auth team |
| Classification | Restricted |

### 11. `google-oauth-client-secret`

| Field | Value |
|-------|-------|
| Secret ARN | `arn:aws:secretsmanager:<region>/<account>/staging/travel-platform/google-oauth-client-secret` |
| Secret value | **REDACTED** |
| Format | Alphanumeric Google OAuth client secret |
| Owning service | auth-service |
| KMS key alias | `alias/staging/platform/secretsmanager` |
| Rotation cadence | 90 days (automated) |
| Rotation owner | Auth team |
| Classification | Restricted |

---

## KMS Keys

| Store | Alias (staging) | Rotation | Purpose |
|-------|----------------|----------|---------|
| `rds` | `alias/staging/platform/rds` | 365 days (AWS-managed) | RDS cluster encryption |
| `elasticache` | `alias/staging/platform/elasticache` | 365 days (AWS-managed) | ElastiCache encryption at rest |
| `s3` | `alias/staging/platform/s3` | 365 days (AWS-managed) | S3 bucket SSE-KMS |
| `sqs` | `alias/staging/platform/sqs` | 365 days (AWS-managed) | SQS queue encryption |
| `secretsmanager` | `alias/staging/platform/secretsmanager` | 365 days (AWS-managed) | Secrets Manager encryption + Terraform state |

---

## Gitleaks Gate Verification

A test branch `feat/gitleaks-gate-proof` was pushed containing a synthetic
credential pattern (a fake `sk_test_` Stripe key). The scan:gitleaks stage
blocked the pipeline with exit code 1. The branch was deleted after recording
the evidence. Pipeline run ID recorded in the Forge Shipping audit log.

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-31 | Initial inventory created (WO-013) | Forge |
