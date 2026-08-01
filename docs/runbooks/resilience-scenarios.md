# Resilience Scenarios Runbook

**WO-099 · Fault Injection and Resilience Test Scenarios**

This runbook documents each resilience scenario, how to inject the fault, the expected observable behaviour, the expected CloudWatch alarm(s), and the idempotent recovery step.

All fault injection targets **staging only**. Never run FIS experiments or Toxiproxy fault injection against production environments.

---

## Table of Contents

1. [Supplier Outage (AC1–AC3, AC14)](#1-supplier-outage)
2. [Redis Outage — Degraded Path (AC4)](#2-redis-outage--degraded-path)
3. [Redis Outage — Exactly-Once Webhook (AC5)](#3-redis-outage--exactly-once-webhook)
4. [Webhook Delay and Expiry (AC6)](#4-webhook-delay-and-expiry)
5. [Saga Compensation (AC7)](#5-saga-compensation)
6. [Adversarial Webhooks (AC8)](#6-adversarial-webhooks)
7. [Health-Check-Driven Traffic Removal (AC9)](#7-health-check-driven-traffic-removal)
8. [Secret Refuse to Start (AC10)](#8-secret-refuse-to-start)
9. [Assistant Runaway / Loop Cap (AC11)](#9-assistant-runaway--loop-cap)
10. [Rate Limiting and Direct-Hit Throttling (AC12)](#10-rate-limiting-and-direct-hit-throttling)
11. [SSRF Allow-List (AC13)](#11-ssrf-allow-list)
12. [Infrastructure Fault Injection — AWS FIS (AC15)](#12-infrastructure-fault-injection--aws-fis)

---

## 1. Supplier Outage

**Scenario file:** `tests/resilience/supplier-outage.scenario.ts`

### Injection command (adapter-level)

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  --reporter=verbose \
  tests/resilience/supplier-outage.scenario.ts
```

### Injection command (infrastructure — Toxiproxy)

```bash
# Add 3 000 ms latency to supplier-a egress (triggers timeout at 2 200 ms)
curl -s -X POST http://toxiproxy.staging.internal:8474/proxies/supplier-a/toxics \
  -H 'Content-Type: application/json' \
  -d '{"name":"latency","type":"latency","attributes":{"latency":3000,"jitter":0}}'

# Run the scenario
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test:staging \
  tests/resilience/supplier-outage.scenario.ts

# Remove the toxic (recovery)
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/supplier-a/toxics/latency
```

### Expected behaviour

- Circuit breaker transitions CLOSED → OPEN after 5 consecutive failures within 10 seconds.
- Requests short-circuit immediately while the breaker is OPEN.
- After 30 seconds, exactly one HALF_OPEN probe is issued; success → CLOSED, failure → OPEN.
- Per-supplier timeout fires at 2 200 ms in normal mode; at 1 500 ms in the Redis-degraded path.
- With one of N suppliers failing, a partial attributed result set is returned — no blank list or 500.
- `CircuitOpenError.supplierName` and `TimeoutError.timeoutMs` are populated; no internal detail appears in client-facing responses.

### Expected alarms

- `supplier-circuit-open` transitions to ALARM when the breaker opens.
- `supplier-partial-results` transitions to ALARM when partial results are served.

### Negative control

Raise the `failureThreshold` in `CircuitBreaker` from 5 to 10 and confirm the scenario fails on the "opens on 5th failure" assertion.

### Recovery step

```bash
# Reset Toxiproxy toxics (idempotent)
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/supplier-a/toxics/latency
# The circuit breaker self-heals on the next successful HALF_OPEN probe (≤ 30 s).
```

---

## 2. Redis Outage — Degraded Path

**Scenario file:** `tests/resilience/redis-outage.scenario.ts` (AC4 tests)

### Injection command

```bash
# Blackhole all traffic to the staging Redis cluster
curl -s -X POST http://toxiproxy.staging.internal:8474/proxies/redis/toxics \
  -H 'Content-Type: application/json' \
  -d '{"name":"blackhole","type":"limit_data","attributes":{"bytes":0}}'

# Run
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test:staging \
  tests/resilience/redis-outage.scenario.ts
```

### Expected behaviour

- Search falls back to direct supplier calls with tightened 1 500 ms per-supplier timeout.
- No error page is returned; partial results are served.
- `search-redis-cache-latency` alarm transitions to ALARM.

### Recovery step

```bash
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/redis/toxics/blackhole
```

---

## 3. Redis Outage — Exactly-Once Webhook

**Scenario file:** `tests/resilience/redis-outage.scenario.ts` (AC5 tests)

### Injection command

Same Redis blackhole as AC4 above. Then drive a duplicate webhook delivery:

```bash
# Deliver the same signed Stripe event twice while Redis is blacked out
./tools/ci/deliver-test-webhook.sh SYNTH-EVT-REDIS-DUP
./tools/ci/deliver-test-webhook.sh SYNTH-EVT-REDIS-DUP  # replay
```

### Expected behaviour

- First delivery: `processed_events` row inserted, booking transitions to CONFIRMED, confirmation email enqueued.
- Second delivery: `processed_events` UNIQUE constraint fires (PostgreSQL error code 23505), outcome = DUPLICATE, no second transition, no second email.

### Expected alarms

- No additional alarm fires for the DUPLICATE outcome (it is an expected idempotency result).
- `search-redis-cache-latency` alarm fires for the Redis degradation.

### Negative control

Drop the `processed_events` unique constraint and confirm the scenario fails (two PROCESSED outcomes for the same event).

### Recovery step

```bash
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/redis/toxics/blackhole
```

---

## 4. Webhook Delay and Expiry

**Scenario file:** `tests/resilience/webhook-delay.scenario.ts`

### Injection command

```bash
# Delay Stripe webhook delivery by 20 minutes (past the 15-minute expiry window)
curl -s -X POST http://toxiproxy.staging.internal:8474/proxies/stripe-webhook/toxics \
  -H 'Content-Type: application/json' \
  -d '{"name":"delay","type":"latency","attributes":{"latency":1200000,"jitter":0}}'

RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test:staging \
  tests/resilience/webhook-delay.scenario.ts
```

### Expected behaviour

- Booking remains PENDING with no confirmation email while the webhook is withheld.
- After the expiry window, booking transitions to EXPIRED; `paymentIntentId` is null (no funds held).
- Late webhook arrival triggers `CONFIRMATION_AFTER_TERMINAL` exception, not a booking confirmation.
- Reconciliation run reports zero unreconciled payments (expired booking had no settled charge).

### Expected alarms

- `CRITICAL-reconciliation-exceptions` when `CONFIRMATION_AFTER_TERMINAL` exception is created.

### Recovery step

```bash
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/stripe-webhook/toxics/delay
```

---

## 5. Saga Compensation

**Scenario file:** `tests/resilience/saga-compensation.scenario.ts`

### Injection command (adapter-level)

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/saga-compensation.scenario.ts
```

### Expected behaviour

- `runCheckoutSaga` returns `success: false` with `failedLegId` identifying the failing leg.
- Previously charged legs produce a `RefundInstruction` in the outcome.
- Compensation proceeds in last-committed-first order.
- No itinerary is created until `success: true` is returned.
- Audit log entries with A10 fields are written for each compensation action.
- After compensation, reconciliation reports zero unreconciled payments (charge + matching refund).

### Expected alarms

- `CRITICAL-reconciliation-exceptions` if compensation fails to issue a refund.

### Negative control

Remove the `compensateAll` call from `runCheckoutSaga` and confirm the refund-instructions assertion fails.

### Recovery step

No staging state to clean up (adapter-level scenario only).

---

## 6. Adversarial Webhooks

**Scenario file:** `tests/resilience/adversarial-webhooks.scenario.ts`

### Injection command

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/adversarial-webhooks.scenario.ts
```

### Expected behaviour

| Payload type | Expected outcome |
|---|---|
| No `Stripe-Signature` header | `SIGNATURE_VERIFICATION_FAILED`, alarm fires |
| Body tampered after signing | `SIGNATURE_VERIFICATION_FAILED`, alarm fires |
| Signed with wrong secret | `SIGNATURE_VERIFICATION_FAILED`, alarm fires |
| Timestamp > 5 minutes stale | `SIGNATURE_VERIFICATION_FAILED`, alarm fires |
| Replay (already processed) | `DUPLICATE`, no alarm fires (valid signature) |

- In every rejection: zero booking state changes, no confirmation email.
- Security event log carries: `event`, `actor`, `resource`, `operation`, `reference`.
- No stack trace, no signing secret value appears in logs.

### Expected alarms

- `stripe-signature-invalid` transitions to ALARM for every non-replay rejection.

### Negative control

Weaken `WebhookVerifier` to skip HMAC comparison and confirm the tampered-payload assertion fails.

### Recovery step

No staging state to clean up (no state changes occur).

---

## 7. Health-Check-Driven Traffic Removal

**Scenario file:** `tests/resilience/health-check-removal.scenario.ts`

### Injection command (adapter-level)

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/health-check-removal.scenario.ts
```

### Injection command (infrastructure — block database)

```bash
# Block all Postgres connections from the booking-service ECS task
curl -s -X POST http://toxiproxy.staging.internal:8474/proxies/postgres/toxics \
  -H 'Content-Type: application/json' \
  -d '{"name":"blackhole","type":"limit_data","attributes":{"bytes":0}}'

# Check /health/ready returns 503
curl -v https://api.staging.travel-platform.internal/health/ready

# Check /health/live still returns 200
curl -v https://api.staging.travel-platform.internal/health/live
```

### Expected behaviour

- `/health/ready` returns 503 and names the failing dependency (`database`, `redis`, or `queue`) in the JSON body.
- `/health/live` always returns 200 (liveness is independent of dependency state).
- A slow probe (> timeout) is also reported as failing.
- No connection strings or credentials appear in the response body.
- ECS health check deregisters the task from the target group when `/health/ready` returns 503.

### Expected alarms

- `booking-service-unhealthy` transitions to ALARM when `/health/ready` returns 503.

### Recovery step

```bash
curl -s -X DELETE http://toxiproxy.staging.internal:8474/proxies/postgres/toxics/blackhole
# ECS re-registers the task once /health/ready returns 200.
```

---

## 8. Secret Refuse to Start

**Scenario file:** `tests/resilience/secret-refuse-to-start.scenario.ts`

### Injection command (adapter-level)

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/secret-refuse-to-start.scenario.ts
```

### Injection command (staging ECS task)

```bash
# Launch a staging task override with a missing secret to confirm non-zero exit
aws ecs run-task \
  --cluster staging-travel-platform \
  --task-definition staging-booking-service \
  --overrides '{"containerOverrides":[{"name":"booking-service","environment":[{"name":"STRIPE_SECRET_KEY","value":""}]}]}' \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<subnet-id>],securityGroups=[<sg-id>],assignPublicIp=DISABLED}'
```

### Expected behaviour

- Task exits with code 1 when any required secret is absent, empty, or matches a known placeholder.
- The violation log names the missing key (never the value).
- `validate()` surfaces ALL violations at once (not one-per-restart).
- The task never registers with the target group (it exits before reaching healthy state).

### Expected alarms

- `booking-service-unhealthy` (task never becomes healthy; ECS health check fails).

### Negative control

Remove `assertSecretsOrExit()` from the service startup and confirm the test observes a healthy task despite invalid secrets.

### Recovery step

No recovery needed — the task never starts with bad secrets.

---

## 9. Assistant Runaway / Loop Cap

**Scenario file:** `tests/resilience/assistant-runaway.scenario.ts`

### Injection command

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/assistant-runaway.scenario.ts
```

### Expected behaviour

- The pre-call governor refuses the 9th tool call (`toolCallCount >= 8`).
- The pre-call governor refuses any call when cumulative tokens reach 60 000.
- Adversarial prompts that attempt to induce loops are limited to 8 real tool invocations.
- Refusal log entry carries `actor`, `resource`, `operation`, `reference`; no prompt content.
- Refusal response offers traditional search as a fallback.

### Expected alarms

- `assistant-governor-cap-exceeded` transitions to ALARM when either cap is hit.

### Negative control

Raise `maxToolCallsPerConversation` to 20 and confirm the "refuses 9th call" assertion fails.

### Recovery step

No staging state to clean up (adapter-level scenario only).

---

## 10. Rate Limiting and Direct-Hit Throttling

**Scenario file:** `tests/resilience/rate-limit-and-direct-hit.scenario.ts`

### Injection command (adapter-level)

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/rate-limit-and-direct-hit.scenario.ts
```

### Injection command (staging WAF burst test)

```bash
# Generate 2001 requests from the same synthetic IP in 5 minutes
./tools/ci/burst-test.sh \
  --url https://api.staging.travel-platform.internal/v1/offers \
  --count 2001 \
  --identity synth-test-ip-001

# Expect the 2001st response to be 429 with Retry-After header
```

### Expected behaviour

- First 2000 requests from the same IP are allowed (WAF window = 5 minutes).
- Request 2001 returns HTTP 429 with a non-zero `Retry-After` header and a reference identifier.
- Per-service direct-hit limiter (500 req/5 min) throttles internal service calls independently.
- Rate-limit identity is isolated per IP or per service key — a different IP is not affected.

### Expected alarms

- `waf-rate-limit-exceeded` transitions to ALARM when the WAF limit is exceeded.

### Recovery step

The sliding window expires naturally after 5 minutes. For immediate reset, restart the rate limiter component.

---

## 11. SSRF Allow-List

**Scenario file:** `tests/resilience/ssrf-allowlist.scenario.ts`

### Injection command

```bash
RESILIENCE_TARGET=staging pnpm --filter @travel/resilience-tests test \
  tests/resilience/ssrf-allowlist.scenario.ts
```

### Expected behaviour

- User-controlled URLs targeting the AWS metadata endpoint (`169.254.169.254`), localhost, RFC 1918 addresses, or `file://` are blocked before any network request is made.
- Security event is logged with `event=SSRF_BLOCKED`, A10 fields, and a reference identifier.
- The raw URL value never appears in the security event log.
- Approved supplier hostnames (`supplier-a.example.com`, `supplier-b.example.com`) pass validation.

### Expected alarms

- No dedicated alarm (SSRF events are logged and surfaced via security event dashboards).

### Negative control

Remove the metadata endpoint IP check from `validateUrl()` and confirm the metadata endpoint test fails.

### Recovery step

No staging state to clean up (allow-list validation is stateless).

---

## 12. Infrastructure Fault Injection — AWS FIS

**Terraform:** `infra/terraform/fis-experiments.tf`

FIS experiments are defined in Terraform and deployed to staging only. Every experiment has an alarm-based stop condition that self-terminates the experiment if a critical alarm fires.

### Available experiment templates

| Template | FIS action | Duration | Stop condition |
|---|---|---|---|
| `ecs-task-stop` | `aws:ecs:stop-task` | Single task | `staging-fis-experiment-stop-condition` |
| `ecs-network-disruption` | `aws:ecs:task-network-latency` | 5 minutes | `staging-fis-experiment-stop-condition` |
| `redis-connection-drop` | `aws:elasticache:interrupt-cluster-az-power` | 2 minutes | `staging-fis-experiment-stop-condition` |
| `rds-az-failover` | `aws:rds:failover-db-cluster` | One-shot | `staging-fis-experiment-stop-condition` |

### Running a FIS experiment

```bash
# Start the ECS task-stop experiment
aws fis start-experiment \
  --experiment-template-id <template-id-from-terraform-output> \
  --region eu-west-1

# Monitor the experiment
aws fis get-experiment --id <experiment-id>
```

### Stop condition

Each template uses `staging-fis-experiment-stop-condition` as its stop condition alarm. If any critical alarm transitions to ALARM during the experiment, FIS terminates the experiment automatically. The experiment also terminates on completion of its configured action.

### Recovery step

FIS experiments are idempotent. All experiments have a defined stop condition and a maximum duration. If an experiment does not self-terminate:

```bash
aws fis stop-experiment --id <experiment-id>
```

For ECS task stop: the ECS service replacement policy restores the desired task count within 2 minutes.

For Redis connection drop: connections re-establish automatically when the ElastiCache cluster recovers.

For RDS AZ failover: the Multi-AZ standby promotes automatically; no manual step required.

---

## General Recovery Checklist

After any fault injection:

1. Verify all Toxiproxy toxics are removed: `curl http://toxiproxy.staging.internal:8474/proxies`
2. Verify all CloudWatch alarms return to OK: `aws cloudwatch describe-alarms --state-value ALARM`
3. Verify ECS desired count matches running count: `aws ecs describe-services --cluster staging-travel-platform`
4. Verify `/health/ready` returns 200 on all services: `curl https://api.staging.travel-platform.internal/health/ready`

---

*This runbook is generated as part of WO-099. Archive scenario results and alarm evidence under S3 key `resilience-evidence/{date}/` for SOC 2 retention.*
