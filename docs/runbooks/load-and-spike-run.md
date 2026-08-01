# Load and Spike Run Runbook

**Owner:** Platform Engineering / SRE  
**Review cycle:** Before each phase gate  
**ADR:** docs/adr/0011-load-test-tooling.md

---

## Overview

Two repeatable load profiles gate the platform against its committed performance budgets:

| Profile | Name | Target RPS | Duration | Trigger |
|---|---|---|---|---|
| A | `sustained-peak` | 600 rps (2× peak gate) | ~18 min | `test:speedscale` pipeline stage before every staging deploy |
| B | `spike-ramp` | 900 rps (3× peak ramp) | ~17 min | On demand, pre-release |

**All threshold values are ASSUMPTION pending sponsor ratification.** To re-baseline any target, edit `tests/load/config/thresholds.json` only — no scenario code changes required.

---

## Pre-Run Environment Verification

**Mandatory before every run. Abort if any check fails.**

### 1. Confirm synthetic-data environment (BR-18)

```bash
# Verify the target database contains no real PII
# The staging DB must have been seeded from the synthetic seed generator, not a prod snapshot.
aws rds describe-db-instances \
  --db-instance-identifier staging-travel-platform \
  --query 'DBInstances[0].DBInstanceIdentifier' \
  --region eu-west-1

# Confirm the most recent restore source is synthetic, not production
aws rds describe-db-snapshots \
  --db-instance-identifier staging-travel-platform \
  --query 'DBSnapshots[-1].SnapshotType' \
  --region eu-west-1
# Expected: "manual" (synthetic seed) NOT "automated" (could be prod copy)
```

**Do not proceed if there is any doubt that production data is present.**

### 2. Confirm supplier sandbox endpoints

```bash
# Check that the flight search service is pointing at the sandbox supplier
curl -s https://api-staging.travel.internal/api/v1/internal/config \
  -H "Authorization: Bearer $INTERNAL_TOKEN" \
  | jq '.supplierEndpoints'
# Expected: all endpoints should be "sandbox" or "mock" tier
```

Supplier calls during load runs must use sandbox endpoints to stay within test-tier quotas.

### 3. Provision synthetic bearer tokens

```bash
# Provision 50 synthetic user accounts in the staging auth service
# Replace with actual provisioning command from the auth service
for i in $(seq 1 50); do
  curl -s -X POST https://api-staging.travel.internal/api/v1/auth/synthetic-user \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"loadtest${i}@example.invalid\", \"role\": \"user\"}"
done
# Capture the bearer token pool and set LOAD_TEST_TOKEN to the first token
export LOAD_TEST_TOKEN=lt_synthetic_1_...
```

### 4. WAF allow-list for generator source address

The WAF enforces a 2000 req/5 min per-IP rate limit. At 600 rps from a single generator address, this limit is reached in ~3 seconds.

```bash
# Add the load generator IP to the WAF allow-list before running
aws wafv2 update-ip-set \
  --scope REGIONAL \
  --id $WAF_LOADTEST_ALLOWLIST_ID \
  --addresses "$GENERATOR_IP/32" \
  --lock-token $(aws wafv2 get-ip-set --scope REGIONAL --id $WAF_LOADTEST_ALLOWLIST_ID --query LockToken --output text) \
  --region eu-west-1
```

**Remove the allow-list entry immediately after the run.**

---

## Running Profile A — Sustained Peak (Pipeline Gate)

The pipeline runs Profile A automatically in the `test:speedscale` stage. To run manually:

```bash
# Set environment variables
export GW_BASE_URL=https://api-staging.travel.internal
export LOAD_TEST_TOKEN=lt_synthetic_1_...
export LOAD_ENV=staging

# Run the profile
k6 run tests/load/profiles/sustained-peak.ts \
  -e GW_BASE_URL="$GW_BASE_URL" \
  -e LOAD_TEST_TOKEN="$LOAD_TEST_TOKEN" \
  -e LOAD_ENV="$LOAD_ENV" \
  --out json=results/sustained-peak.json

# Export CloudWatch p95 metrics (wait 5 min after run for metrics to propagate)
aws cloudwatch get-metric-statistics \
  --namespace travel/platform \
  --metric-name SearchCacheHitLatencyP95 \
  --start-time "$(date -u -d '40 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --period 60 --statistics p95 \
  --region eu-west-1 \
  --output json > results/sustained-peak-cw.json

# Generate report
node --import tsx/esm tests/load/reporting/generate-report.ts \
  --profile sustained-peak \
  --k6-json results/sustained-peak.json \
  --cw-json results/sustained-peak-cw.json \
  --out-json results/sustained-peak-report.json \
  --out-md results/sustained-peak-report.md
```

---

## Running Profile B — Spike Ramp (On Demand)

```bash
export GW_BASE_URL=https://api-staging.travel.internal
export LOAD_TEST_TOKEN=lt_synthetic_1_...
export LOAD_ENV=staging

k6 run tests/load/profiles/spike-ramp.ts \
  -e GW_BASE_URL="$GW_BASE_URL" \
  -e LOAD_TEST_TOKEN="$LOAD_TEST_TOKEN" \
  -e LOAD_ENV="$LOAD_ENV" \
  --out json=results/spike-ramp.json

# Export CloudWatch metrics after run
aws cloudwatch get-metric-statistics \
  --namespace travel/platform \
  --metric-name SearchServiceRunningTaskCount \
  --start-time "$(date -u -d '40 minutes ago' '+%Y-%m-%dT%H:%M:%SZ')" \
  --end-time "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --period 60 --statistics Average \
  --region eu-west-1 \
  --output json > results/spike-ramp-cw.json

node --import tsx/esm tests/load/reporting/generate-report.ts \
  --profile spike-ramp \
  --k6-json results/spike-ramp.json \
  --cw-json results/spike-ramp-cw.json \
  --out-json results/spike-ramp-report.json \
  --out-md results/spike-ramp-report.md
```

---

## Low-Concurrency Smoke Run (Validation Only)

Before any full-scale run, validate scenario correctness:

```bash
# Profile A smoke (5 iterations, 2 VUs)
k6 run tests/load/profiles/sustained-peak.ts \
  -e GW_BASE_URL="$GW_BASE_URL" \
  -e LOAD_TEST_TOKEN="$LOAD_TEST_TOKEN" \
  --iterations 5 --vus 2

# Profile B smoke
k6 run tests/load/profiles/spike-ramp.ts \
  -e GW_BASE_URL="$GW_BASE_URL" \
  -e LOAD_TEST_TOKEN="$LOAD_TEST_TOKEN" \
  --iterations 5 --vus 2
```

---

## Live Monitoring During the Run

Monitor these dashboards during any full-scale run:

| Dashboard | What to watch |
|---|---|
| CloudWatch: ECS > RunningTaskCount | Confirms step scaling fires within 2-minute breach window |
| CloudWatch: ALB > RequestCountPerTarget | Triggers the step-scaling policy |
| CloudWatch: RDS > DatabaseConnections | R9 assertion — stays ≤5 per task |
| CloudWatch: ElastiCache > CacheMisses | Confirms miss cohort is generating genuine misses |
| CloudWatch: SQS > ApproximateNumberOfMessagesVisible | Notification backlog drain |
| k6 terminal output | Real-time p95 and fault rate |

### Expected alarms during Profile B spike ramp

These alarms are EXPECTED to fire during the spike — acknowledge but do not act unless capacity fails to scale within 4 minutes:

- `ALBHighRequestCount` — fires at ~500 rps (expected during ramp)
- `ECSHighCPU` — fires when new tasks are provisioning (transient)
- `SearchServiceScaleOut` — confirms the step policy fired

These alarms should NOT fire:

- `SearchP95Breached` — fires if search p95 exceeds 5 s hard-alert ceiling
- `CheckoutPlatformFailureHigh` — fires if checkout fault rate exceeds 0.5%
- `RDSConnectionsHigh` — fires if DB connections exceed per-task ceiling

---

## Abort Procedure

**To abort a running k6 run:** press `Ctrl+C` in the k6 terminal or send `SIGTERM` to the k6 process.

**After aborting, restore baseline capacity immediately:**

```bash
# Reset desired task count to minimum for all services
for service in auth-service booking-service search-service gateway; do
  aws ecs update-service \
    --cluster staging-travel-platform \
    --service "staging-${service}" \
    --desired-count $(cat infra/terraform/modules/ecs-service/variables.tf | grep min_capacity | head -1 | grep -o '[0-9]*') \
    --region eu-west-1
done

# Clear synthetic SQS backlog
aws sqs purge-queue \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/123456789012/staging-notifications" \
  --region eu-west-1

# Remove WAF allow-list entry
aws wafv2 update-ip-set \
  --scope REGIONAL \
  --id $WAF_LOADTEST_ALLOWLIST_ID \
  --addresses "" \
  --lock-token $(aws wafv2 get-ip-set --scope REGIONAL --id $WAF_LOADTEST_ALLOWLIST_ID --query LockToken --output text) \
  --region eu-west-1
```

---

## Post-Run Capacity Restoration

After a successful run, the ECS services will scale back down via target-tracking CPU policy. Verify within 10 minutes:

```bash
# Confirm all services have scaled back toward minimum
aws ecs describe-services \
  --cluster staging-travel-platform \
  --services staging-search-service staging-gateway \
  --query 'services[*].{service:serviceName,running:runningCount,desired:desiredCount}' \
  --region eu-west-1
```

---

## Step-Scaling Verification (Profile B)

To confirm the step-scaling policy fired on a 2-minute ALB RequestCountPerTarget breach:

```bash
# Retrieve scaling activities during the spike window
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/staging-travel-platform/staging-search-service \
  --region eu-west-1 \
  --query 'ScalingActivities[*].{time:StartTime,cause:Cause,change:Description}' \
  | jq '.[] | select(.cause | contains("RequestCountPerTarget"))'
```

Expected: at least one entry showing `PercentChangeInCapacity=100` triggered by `RequestCountPerTarget` breach.

---

## Interpreting the Report

The `generate-report.ts` script produces two files:

- `results/*-report.json` — machine-readable; ingested by the pipeline gate
- `results/*-report.md` — human-readable summary with per-budget verdicts

**MISSING_DATA verdict** means either the k6 JSON was not produced (generator error) or the CloudWatch JSON was not exported. The gate fails explicitly on MISSING_DATA — it does not silently fall back to client-only measurements.

**Client-only measurement** occurs when CloudWatch metrics are not available. The verdict is still computed from k6 client-side p95 but flagged in the report. Cross-check with the CloudWatch dashboard to confirm before accepting.

---

## Eviction-Caused Latency Regression

If the search cache miss p95 exceeds 3 s and the CloudWatch `CacheEvictions` metric is non-zero, the regression may be caused by ElastiCache eviction rather than supplier slowness. The report records both; investigate cache sizing before attributing to supplier performance.

---

## SOC 2 Evidence Archiving

The pipeline automatically uploads `results/gate-report.*` as a retained Forge artefact (`load-gate-evidence-<sha>`) with 365-day retention. Retrieve for audit:

```bash
# List load gate artefacts for a specific commit
gh run list --workflow forge-shipping --limit 20
gh run download <run-id> --name "load-gate-evidence-<sha>" --dir results/
```
