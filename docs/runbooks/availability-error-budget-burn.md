# Runbook: Availability SLO Error-Budget Burn

**Alarms:** `CRITICAL-availability-slo-fast-burn`, `HIGH-availability-slo-slow-burn`, `CRITICAL-platform-degradation-composite`, `HIGH-latency-degradation-composite`
**Severity:** CRITICAL (fast-burn, composite) / HIGH (slow-burn)
**SNS Topic:** platform-page (fast-burn) / platform-ticket (slow-burn)

## Signal Meaning

Monthly SLO: **99.5% availability** (0.5% error budget ≈ 216 minutes/month)

| Alarm | Rate | Budget consumed | Meaning |
|---|---|---|---|
| `availability-slo-fast-burn` | >7.2% error rate (1h window) | 2% in 1h (14.4× burn) | Rapid degradation — SLO will exhaust in ~50 hours at this rate |
| `availability-slo-slow-burn` | >3.0% error rate (6h window) | 5% in 6h (6× burn) | Sustained degradation — SLO exhausted in ~5 days |
| `platform-degradation-composite` | Both search + checkout fault | Platform-wide | Deployment or infrastructure incident |
| `latency-degradation-composite` | Both search + checkout latency | Platform-wide | Shared dependency (database, Redis, network) |

The **composite alarms** fire only when multiple journey alarms trigger simultaneously, indicating a platform-wide incident rather than a single-service deployment event.

## Diagnostic Steps

1. **Open the Platform Health Dashboard** → `{environment}-platform-health`. Check the availability SLO widget (top row). Confirm whether the error rate is still rising or has plateaued. Check the ALB HealthyHostCount widget — a drop in healthy hosts indicates an infrastructure event.

2. **Run the Logs Insights query** against all services using the correlation ID from the alarm notification:
   ```
   fields @timestamp, @logStream, service, statusCode, errorCode, correlationId, @message
   | filter statusCode >= 500
   | stats count(*) as errors by service, statusCode, errorCode
   | sort errors desc
   | limit 30
   ```
   Replace `statusCode >= 500` with `level >= 50` if services are not emitting HTTP status fields.

3. **Check recent deployments**: `aws ecs list-task-definitions --sort DESC | head -20` and cross-reference with the alarm start time. If a deployment correlates, initiate a rollback via the ECS service: `aws ecs update-service --cluster {cluster} --service {service} --task-definition {previous-revision}`.

## Expected Blast Radius

- Fast-burn: significant percentage of all user-facing requests are failing. All journeys affected.
- Slow-burn: sustained lower-level degradation that will exhaust the monthly SLO if not addressed.

## Escalation

- Composite alarm firing: declare P1 incident. Notify Engineering Director.
- Fast-burn with no identified root cause after 15 min: page on-call SRE lead.
- Error budget below 25% remaining for the month: file engineering review request for the next sprint.
