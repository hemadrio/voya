# Telemetry Verification Runbook

**Purpose:** Verify end-to-end observability — confirm that a request produces
a trace in X-Ray and correlated Pino JSON log lines in CloudWatch Logs Insights.

**Audience:** On-call engineers, post-deploy verification, SOC 2 change-management evidence.

**Prerequisites:**
- AWS CLI configured for the target environment (`AWS_PROFILE=travel-{env}`)
- jq, curl installed locally
- Both containers (`test-service` and `adot-collector`) in RUNNING state (verify below)

---

## 1. Confirm both containers are RUNNING

```bash
ENV=dev          # dev | staging | production
SERVICE=auth-service

aws ecs list-tasks \
  --cluster "${ENV}-travel-platform" \
  --service-name "${ENV}-${SERVICE}" \
  --query 'taskArns[0]' --output text | xargs -I{} \
aws ecs describe-tasks \
  --cluster "${ENV}-travel-platform" \
  --tasks {} \
  --query 'tasks[0].containers[*].{name:name,status:lastStatus}'
```

Expected output — both containers show `RUNNING`:
```json
[
  { "name": "auth-service",    "status": "RUNNING" },
  { "name": "adot-collector",  "status": "RUNNING" }
]
```

If `adot-collector` is in `STOPPED` or `FAILED`, the application continues to
serve traffic (essential=false), but telemetry is silently dropped. Check the
collector log stream (step 5) for AccessDenied entries before escalating.

---

## 2. Issue a synthetic search request

Use the committed sample payload or generate a live request.

### Option A — Use the committed OTLP payload (repeatably, no real traffic)

Send the OTLP payload directly to the sidecar via an ECS Exec session:

```bash
TASK_ARN=$(aws ecs list-tasks \
  --cluster "${ENV}-travel-platform" \
  --service-name "${ENV}-auth-service" \
  --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster "${ENV}-travel-platform" \
  --task "${TASK_ARN}" \
  --container auth-service \
  --interactive \
  --command "curl -s -X POST http://127.0.0.1:4318/v1/traces \
    -H 'Content-Type: application/json' \
    -d @/dev/stdin" \
  < scripts/otlp-sample-payload.json
```

Note the `traceId` value from the payload — this is the reference value.

### Option B — Issue a real HTTP request through the ALB

```bash
DOMAIN=api.travel.example.com   # replace with your environment domain

RESPONSE=$(curl -s -X POST "https://${DOMAIN}/v1/flights/search" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"LHR","destination":"JFK","departureDate":"2026-09-15","cabinClass":"economy","passengers":{"adults":1}}')

echo "$RESPONSE" | jq .
REFERENCE=$(echo "$RESPONSE" | jq -r '.reference // .error.reference')
echo "Reference value: ${REFERENCE}"
```

The `reference` field in every error envelope equals the active X-Ray trace
identifier. For a successful response, X-Ray trace IDs can be correlated via
the `x-amzn-trace-id` response header.

---

## 3. Locate the X-Ray trace

```bash
# Allow up to 60 s for the batch processor to flush spans to X-Ray.
sleep 15

# Convert reference to X-Ray trace ID format (1-{hex8}-{hex24})
TRACE_ID="${REFERENCE}"

aws xray get-traces \
  --trace-ids "${TRACE_ID}" \
  --query 'Traces[0].Segments[*].Document' \
  --output text | jq .
```

Confirm:
- `service.name` matches the originating service (e.g. `auth-service`)
- `origin` shows `AWS::ECS::Container`
- Resource detection labels include `aws.ecs.cluster.name` and `aws.ecs.task.arn`

---

## 4. Locate the matching log lines in CloudWatch

Open CloudWatch Logs Insights and run:

```sql
fields @timestamp, @message
| filter correlationId = "<REFERENCE_VALUE>"
| sort @timestamp asc
| limit 50
```

Target log group: `/ecs/<ENV>/<SERVICE>` (e.g. `/ecs/dev/auth-service`).

Via CLI:

```bash
LOG_GROUP="/ecs/${ENV}/auth-service"
CORRELATION_ID="${REFERENCE}"

aws logs start-query \
  --log-group-name "${LOG_GROUP}" \
  --start-time $(date -d '5 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string "fields @timestamp, @message | filter correlationId = \"${CORRELATION_ID}\" | sort @timestamp asc | limit 50" \
  --output text

# Note the queryId, then:
aws logs get-query-results --query-id <QUERY_ID> | jq '.results[][]'
```

Expected: Structured Pino JSON objects with `correlationId` matching `${REFERENCE}`,
`level`, `msg`, and request/response context fields. Each line is a single JSON
object (no multiline splitting).

---

## 5. Check the ADOT collector log stream for errors

```bash
LOG_GROUP="/ecs/${ENV}/auth-service"

aws logs filter-log-events \
  --log-group-name "${LOG_GROUP}" \
  --log-stream-name-prefix "adot-collector" \
  --filter-pattern "ERROR" \
  --start-time $(date -d '10 minutes ago' +%s000) \
  --query 'events[*].message' \
  --output text
```

Common issues and resolutions:

| Error pattern                          | Cause                                    | Fix                                                      |
|----------------------------------------|------------------------------------------|----------------------------------------------------------|
| `AccessDenied ... xray:PutTraceSegments` | Task role missing X-Ray permission     | Re-apply Terraform; check `aws_iam_role_policy.telemetry` |
| `AccessDenied ... cloudwatch:PutMetricData` | Namespace condition mismatch         | Verify `cloudwatch_namespace` var matches emitter config |
| `dial tcp: connect: connection refused` | OTLP receiver not bound to 127.0.0.1  | Check `AOT_CONFIG_CONTENT` env var in task definition    |
| `context deadline exceeded`            | X-Ray endpoint not reachable from VPC   | Add VPC endpoint for `xray` or open egress to `0.0.0.0/0:443` |

---

## 6. Circuit breaker rollback verification

To verify that a bad deployment rolls back automatically:

```bash
# 1. Deploy an image that fails /health/ready (e.g. wrong PORT env var):
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-auth-service" \
  --task-definition "${ENV}-auth-service:BAD_REVISION" \
  --force-new-deployment

# 2. Watch deployment state:
watch -n 10 "aws ecs describe-services \
  --cluster '${ENV}-travel-platform' \
  --services '${ENV}-auth-service' \
  --query 'services[0].{status:status,deployments:deployments[*].{id:id,status:status,desiredCount:desiredCount,runningCount:runningCount,rolloutState:rolloutState}}'"

# Expected: deploymentCircuitBreaker.status transitions to FAILED within ~5 min,
# service rolls back to the previous ACTIVE task definition revision.
```

Record the observed rollback duration (target: < 5 minutes) in the post-deploy
evidence comment on the PR.

---

## 7. Target group health check verification

```bash
# Find the target group ARN:
TG_ARN=$(aws elbv2 describe-target-groups \
  --names "${ENV}-auth-service" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Check registered target health:
aws elbv2 describe-target-health \
  --target-group-arn "${TG_ARN}" \
  --query 'TargetHealthDescriptions[*].{ip:Target.Id,port:Target.Port,state:TargetHealth.State,reason:TargetHealth.Reason}'
```

Expected: all targets show `State: healthy`. If a target shows `unhealthy`,
check `/health/ready` response from within the VPC:

```bash
# Via ECS Exec:
aws ecs execute-command \
  --cluster "${ENV}-travel-platform" \
  --task "${TASK_ARN}" \
  --container auth-service \
  --interactive \
  --command "wget -qO- http://localhost:3000/health/ready"
```

A `200 OK` with JSON body `{"status":"ok","checks":{...}}` confirms all required
dependencies (RDS, Redis, secrets) are reachable.
