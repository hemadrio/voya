# Scaling Evidence — WO-082: Autoscaling Policies Proving 3× Capacity Within Ten Minutes

This directory contains measured evidence from synthetic load runs executed against
the **staging environment only** (BR-18). Each run is committed here with timestamps,
CloudWatch task-count series, and p95 latency series.

## Acceptance Criteria Proven by Evidence

| # | Criterion | Evidence Location |
|---|-----------|-------------------|
| AC1 | Autoscaling targets exist for all 9 request-handling services | `terraform plan` output in `plan-assertions/` |
| AC2 | CPU target-tracking at 60%, asymmetric cooldowns | Terraform plan assertions, see `tests/autoscaling.tftest.hcl` |
| AC3 | Step scaling adds 100% capacity on 2-period ALB breach | Terraform plan assertions + `run-YYYYMMDD/scale-events.json` |
| AC6 | Fleet reaches ≥3× task count within 10 minutes | `run-YYYYMMDD/task-count-series.json` |
| AC7 | Zero capacity-attributable 5xx, p95 < 5000 ms during ramp | `run-YYYYMMDD/latency-p95-series.json` |

## Directory Layout

```
docs/reliability/scaling-evidence/
├── README.md                          # This file
└── run-YYYYMMDD-HHMMSS/               # One directory per measured run
    ├── metadata.json                  # Run timestamp, environment, operator
    ├── task-count-series.json         # CloudWatch RunningTaskCount per service (60s periods)
    ├── latency-p95-series.json        # search p95 from travel/search namespace (60s periods)
    ├── scale-events.json              # App Auto Scaling activity log (step/target events)
    ├── 5xx-rate.json                  # ALB HTTPCode_Target_5XX_Count (must be zero)
    └── SUMMARY.md                     # Human-readable run summary
```

## How to Execute a Measured Run

> **STAGING ONLY.** Never run synthetic load against production (BR-18).
> Staging contains synthetic data exclusively.

### Prerequisites

1. **Verify Fargate quota headroom** before the first run:
   ```bash
   aws service-quotas get-service-quota \
     --service-code fargate \
     --quota-code L-790BEEDA \
     --query 'Quota.Value'
   ```
   Required minimum: **200 tasks** (sum of all service `max_capacity` = 154 + buffer).
   Request an increase at the [Service Quotas console](https://console.aws.amazon.com/servicequotas/home/services/fargate/quotas)
   before proceeding if quota < 200.

2. **Confirm steady-state task counts** (all services at `min_capacity`):
   ```bash
   aws ecs describe-services \
     --cluster staging-travel-platform \
     --services staging-flight-service staging-hotel-service staging-car-service \
               staging-api-gateway \
     --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount}'
   ```

3. **Confirm autoscaling is registered** (all four step+CPU services):
   ```bash
   aws application-autoscaling describe-scalable-targets \
     --service-namespace ecs \
     --query 'ScalableTargets[*].{Resource:ResourceId,Min:MinCapacity,Max:MaxCapacity}'
   ```

### Step 1: Baseline measurement

Record baseline RunningTaskCount for all services (steady-state `min_capacity`):
```bash
BASELINE_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws cloudwatch get-metric-statistics \
  --namespace ECS/ContainerInsights \
  --metric-name RunningTaskCount \
  --dimensions Name=ClusterName,Value=staging-travel-platform \
  --start-time "$BASELINE_TIME" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 \
  --statistics Maximum \
  --output json > run-${RUN_ID}/task-count-baseline.json
```

### Step 2: Execute the 3× ramp

Run the load profile from `tools/loadtest/scaling-profile.yaml` against staging:
```bash
RUN_ID=$(date -u +%Y%m%d-%H%M%S)
mkdir -p docs/reliability/scaling-evidence/run-${RUN_ID}

# Example using k6 (substitute your load-test runner):
k6 run \
  --env ENVIRONMENT=staging \
  --env TARGET_HOST=https://api.staging.travel-platform.internal \
  tools/loadtest/k6-scaling-ramp.js \
  --out json=run-${RUN_ID}/k6-output.json

START_TIME=$(cat run-${RUN_ID}/k6-output.json | jq -r '.metrics.http_req_duration.values.min' | xargs -I{} date -u +%Y-%m-%dT%H:%M:%SZ)
```

### Step 3: Collect task-count series

Collect CloudWatch metrics for all four autoscaling-active request-handler services
for the 15-minute window covering ramp + stabilisation:

```bash
for SERVICE in flight-service hotel-service car-service api-gateway; do
  aws cloudwatch get-metric-statistics \
    --namespace ECS/ContainerInsights \
    --metric-name RunningTaskCount \
    --dimensions Name=ClusterName,Value=staging-travel-platform \
                 Name=ServiceName,Value=staging-${SERVICE} \
    --start-time "${START_TIME}" \
    --end-time "$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
    --period 60 \
    --statistics Maximum \
    --output json >> run-${RUN_ID}/task-count-series.json
done
```

### Step 4: Collect p95 latency series

```bash
aws cloudwatch get-metric-statistics \
  --namespace travel/search \
  --metric-name SearchLatencyByCategory \
  --start-time "${START_TIME}" \
  --end-time "$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 \
  --extended-statistics p95 \
  --output json > run-${RUN_ID}/latency-p95-series.json
```

### Step 5: Check 5xx rate (must be zero)

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApplicationELB \
  --metric-name HTTPCode_Target_5XX_Count \
  --dimensions Name=LoadBalancer,Value=$(aws elbv2 describe-load-balancers \
    --names staging-travel-alb --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text | sed 's|.*:loadbalancer/||') \
  --start-time "${START_TIME}" \
  --end-time "$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  --period 900 \
  --statistics Sum \
  --output json > run-${RUN_ID}/5xx-rate.json
```

### Step 6: Verify 3× task count within 10 minutes

Inspect the task-count series. Each search service must reach ≥3× its
`min_capacity` (3→9 tasks) and api-gateway must reach ≥3× (4→12) within 10
minutes of the ramp start:

```bash
jq '.Datapoints | sort_by(.Timestamp) | .[] | {t: .Timestamp, max: .Maximum}' \
  run-${RUN_ID}/task-count-series.json
```

### Step 7: Run queue-flood fixture (consumer autoscaling)

```bash
# Send 150 synthetic notification messages to staging notifications queue
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws sqs send-message-batch \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/${ACCOUNT_ID}/staging-notifications" \
  --entries file://tools/loadtest/fixtures/notification-flood-batch.json
```

Watch notification-consumer scale independently while flight/hotel/car stay flat.

### Step 8: DLQ poison-message test

```bash
aws sqs send-message \
  --queue-url "https://sqs.eu-west-1.amazonaws.com/${ACCOUNT_ID}/staging-notifications" \
  --message-body "POISON_PILL_FORCE_DLQ" \
  --message-group-id "dlq-test-$(date +%s)" \
  --message-deduplication-id "dlq-test-$(date +%s)"
```

Wait for the message to exhaust retries (5 × visibility timeout = ~25 minutes), then
verify the `staging-notifications-dlq-depth` alarm transitions to ALARM and both SNS
topics (`staging-travel-platform-alarms` and `staging-platform-page`) receive
the notification.

### Step 9: Commit evidence

```bash
cat > run-${RUN_ID}/metadata.json <<EOF
{
  "run_id": "${RUN_ID}",
  "environment": "staging",
  "operator": "$(git config user.email)",
  "started_at": "${START_TIME}",
  "profile": "tools/loadtest/scaling-profile.yaml",
  "fargate_quota_verified": true,
  "wo": "WO-082"
}
EOF

cat > run-${RUN_ID}/SUMMARY.md <<'EOF'
# Run ${RUN_ID} — Scaling Evidence Summary

## Result

- [ ] Fleet reached ≥3× task count within 10 minutes (PASS/FAIL)
- [ ] Zero capacity-attributable 5xx (PASS/FAIL)
- [ ] Search p95 < 5000 ms throughout ramp (PASS/FAIL)
- [ ] Consumer scaled independently on queue depth (PASS/FAIL)
- [ ] DLQ alarm fired to both SNS topics (PASS/FAIL)

## Key Observations

- Time to 3× (flight-service): ? minutes
- Time to 3× (api-gateway):    ? minutes
- Peak p95 latency:             ? ms
- Peak task count (flight):     ?
- Consumer peak task count:     ?

## CloudWatch Links

- Task count graph: [link]
- p95 latency graph: [link]
- Scaling activity: [link]
EOF

git add docs/reliability/scaling-evidence/run-${RUN_ID}/
git commit -m "docs: add scaling evidence run ${RUN_ID} (WO-082)"
```

## SQS Metric Publication Lag

`ApproximateNumberOfMessagesVisible` is published approximately every **60 seconds**.
Notification-consumer scaling therefore reacts ~1 period (60 s) later than
request-handler scaling. This lag is expected and documented — the queue-flood
fixture accounts for it by sustaining the flood for at least 3 minutes.

## Quarterly Drill Schedule

| Quarter | Date | Operator | Result |
|---------|------|----------|--------|
| Q3 2026 | TBD  | —        | —      |
| Q4 2026 | TBD  | —        | —      |

Drills must be announced in the `#on-call` channel at least 48 hours in advance.
Results are committed to this directory within 24 hours of the drill.
