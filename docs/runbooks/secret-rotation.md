# Runbook: Secret Rotation and JWT Key Rollover

**Runbook ID:** RB-023
**Alarms:** `CRITICAL-secret-startup-validation-failure`
**Severity:** CRITICAL (service refuses to start with missing or placeholder secrets)
**SNS Topic:** platform-page
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## 1. Severity and blast radius

**Severity:** The startup validator exits non-zero when any required secret is
absent, empty, or matches a known placeholder pattern. The ECS task will not
start, which triggers an ECS service stabilisation failure. Existing tasks
continue running until they are replaced.

**Blast radius:**
- Deployments fail: new task revisions cannot start if the new secret is not
  yet in Secrets Manager.
- Existing running tasks: continue operating on the old secret until they are
  replaced (overlapping verification window).
- JWT 401 storm risk: if the signing key is rotated without an overlapping
  verification window, in-flight tokens signed by the old key will be rejected.
- Stripe webhook secret: if `STRIPE_WEBHOOK_SECRET` is absent or wrong, all
  webhook deliveries fail signature verification → bookings stuck PENDING.

**What is never acceptable:**
- Plaintext secret values in code, configuration files, logs, traces, metrics,
  or Terraform state. Use Secrets Manager ARN references only.
- Placeholder values (`dev-secret-change-me`, `change-me`, empty string) in
  production or staging.

---

## 2. Architecture thresholds (from spec — do not invent new values)

| Parameter | Value |
|-----------|-------|
| Maximum rotation cycle | 90 days |
| JWT verification overlap window | Configurable; must cover the maximum token lifetime |
| Startup validator: rejects absent key | Yes — exits 1 |
| Startup validator: rejects placeholder | Yes — exits 1 (matches known patterns) |
| Startup validator: rejects key too short | Yes — exits 1 (minimum entropy threshold) |
| KMS key for JWT signing | AWS KMS CMK, key ARN injected from Secrets Manager |

---

## 3. Detection signal

```
ALARM: CRITICAL-secret-startup-validation-failure
Namespace: travel/security
Metric:    secret_startup_validation_failures_total
Threshold: ≥ 1 within a 5-minute window
treat_missing_data: notBreaching (absence is OK; presence is a hard signal)
```

**What the alarm means:** A service task attempted to start and the startup
validator rejected one or more required secrets. This could be caused by a
rotation that has not yet been applied, a misconfigured Secrets Manager policy,
or a deployment with a stale task definition referencing an old secret ARN.

**Co-firing alarms:** ECS service stabilisation alerts may fire alongside this
if the service cannot reach a stable desired-count state.

---

## 4. Triage — start from the reference identifier

Startup validation failures are logged before the HTTP server starts, so they
will not have a traveler-supplied reference identifier. Use the task ARN
instead.

**Step 1 — Find the failing task and its startup logs:**

```bash
ENV=staging
SERVICE=auth-service   # or the service named in the alarm

# List recently stopped tasks (failed start = STOPPED immediately)
aws ecs list-tasks \
  --cluster "${ENV}-travel-platform" \
  --service-name "${ENV}-${SERVICE}" \
  --desired-status STOPPED \
  --query 'taskArns[0:5]' \
  --output text
```

**Step 2 — Read startup logs for the failing task:**

```bash
TASK_ARN="<task-arn-from-step-1>"
STREAM="${TASK_ARN##*/}"

aws logs get-log-events \
  --log-group-name "/ecs/${ENV}/${SERVICE}" \
  --log-stream-name "ecs/${SERVICE}/${STREAM}" \
  --limit 50 \
  --query 'events[*].message' \
  --output text
```

Look for log lines matching:
- `"CONFIG ERROR: Secret validation failed"` — names which secret key is missing.
- `"STARTUP REFUSED"` — the service refused to start.

**Step 3 — Identify which secret failed:**

The startup validator logs the secret key name (never the value) and the failure
reason (`ABSENT`, `PLACEHOLDER`, `TOO_SHORT`). Use the key name to locate the
Secrets Manager secret.

**Fallback (no logs visible — task crashed before CloudWatch agent started):**
Check ECS task stopped reason:
```bash
aws ecs describe-tasks \
  --cluster "${ENV}-travel-platform" \
  --tasks "${TASK_ARN}" \
  --query 'tasks[0].{StoppedReason:stoppedReason,ExitCode:containers[0].exitCode}' \
  --output table
```

---

## 5. Decision tree

```
CRITICAL-secret-startup-validation-failure fires
  └─ What is the failure reason? (check startup logs)
       ├─ ABSENT → The secret does not exist in Secrets Manager (Step 6.1)
       ├─ PLACEHOLDER → Secret exists but contains a placeholder value (Step 6.2)
       └─ TOO_SHORT → Secret exists but below minimum entropy threshold (Step 6.3)

For JWT key rotation specifically:
  └─ Is this a planned rotation?
       ├─ YES → Follow the planned rotation procedure (Step 6.4)
       └─ NO  → Unplanned: treat as incident, escalate (Section 8)
```

---

## 6. Remediation steps

### Step 1 — Secret absent: create the secret in Secrets Manager

```bash
# Create the secret (placeholder command — substitute real ARN and key name)
aws secretsmanager create-secret \
  --name "/${ENV}/<service>/<secret-key-name>" \
  --description "Injected by on-call — replace with proper rotation" \
  --secret-string "PLACEHOLDER-MUST-BE-REPLACED"

# Then immediately update it with the correct value (never log the value)
aws secretsmanager put-secret-value \
  --secret-id "/${ENV}/<service>/<secret-key-name>" \
  --secret-string "<actual-secret-value>"
```

> **Security:** Never include the actual secret value in Slack messages, tickets,
> or incident notes. Reference the Secrets Manager ARN only.

### Step 2 — Placeholder value: update the secret

```bash
aws secretsmanager put-secret-value \
  --secret-id "/${ENV}/<service>/<secret-key-name>" \
  --secret-string "<actual-secret-value>"
```

After updating, force a new deployment to pull the new value:

```bash
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-<service-name>" \
  --force-new-deployment
```

### Step 3 — JWT key rotation with overlapping verification window

JWT key rotation is the most sensitive operation. The overlap window ensures
in-flight tokens signed by the old key remain valid while new tokens are signed
by the new key.

**Overlap procedure:**
1. Generate the new KMS CMK or update the JWT signing key in Secrets Manager.
2. Configure the service to verify tokens with BOTH the old and new keys
   (dual-verify mode) — the service must accept both during the overlap window.
3. Deploy the updated task definition.
4. After the maximum token lifetime has elapsed (all old tokens have expired or
   been replaced), remove the old key from the verification set.
5. Deploy again to disable dual-verify mode.

> **Critical:** Step 3 must not be skipped. Removing the old key before the
> overlap window closes will reject all in-flight sessions and cause a 401 storm.

### Step 4 — Verify new tasks start successfully

```bash
aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-<service-name>"

# Confirm running task count matches desired
aws ecs describe-services \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-<service-name>" \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}'
```

### Step 5 — Verify the alarm cleared

```bash
aws cloudwatch describe-alarms \
  --alarm-names "CRITICAL-secret-startup-validation-failure" \
  --query 'MetricAlarms[0].StateValue' \
  --output text
```

Expected: `OK`

---

## 7. Verification

- [ ] `CRITICAL-secret-startup-validation-failure` → `OK`
- [ ] ECS service desired count == running count (no stuck pending tasks)
- [ ] Service health endpoint: `GET /health` → `200 { "status": "ok" }`
- [ ] No new `secret_startup_validation_failures_total` increments in CloudWatch
- [ ] If JWT rotation: auth service accepts both old and new tokens during overlap window
- [ ] Stripe webhook: `POST /webhooks/stripe` with a valid test payload → `200` (if webhook secret was rotated)

---

## 8. Rollback

```bash
# If the new secret is incorrect and the old task definition still worked
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-<service-name>" \
  --task-definition "${ENV}-<service-name>:<PREVIOUS_REVISION>" \
  --force-new-deployment

aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-<service-name>"
```

**Rollback target:** previous immutable task definition revision (n-1).
**Time to recover:** under 5 minutes via the previous task definition revision procedure.

**Important:** rolling back the task definition does NOT roll back the Secrets Manager
value. The old task definition will use whatever value is currently in Secrets Manager.
If the secret value itself was changed, ensure the previous value is restored before rolling back.

---

## 9. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Startup validation failure on any service | Platform On-Call | PagerDuty | Immediate |
| JWT key rotation incident | Security Lead + Head of Engineering | `#security-incidents` | Immediate |
| Stripe webhook secret mismatch | Platform On-Call | `#platform-ops` | 15 min |
| 401 storm (auth rejecting all tokens) | Head of Engineering | `#incidents` + page | Immediate |

---

## 10. Post-incident evidence capture (SOC 2)

1. Export startup logs for the failing task ARN from CloudWatch.
2. Record: which secret failed validation, failure reason, duration of outage,
   services affected, resolution method (secret update vs. rollback).
3. Record the Secrets Manager ARN (never the value) and the rotation event timestamp.
4. Archive to `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-secret-rotation/`.
5. Update the secret rotation schedule in the key management register if the failure
   was caused by a rotation that was not completed within the 90-day cycle.
