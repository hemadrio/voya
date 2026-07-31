# Runbook: ADOT Collector Exporter Failure

**Alarm:** `HIGH-adot-exporter-failure`
**Severity:** HIGH
**SNS Topic:** platform-ticket

## Signal Meaning

The AWS Distro for OpenTelemetry (ADOT) sidecar has failed to export metrics or traces to CloudWatch or X-Ray. While the application continues running, observability data will be missing:

- CloudWatch EMF metrics will not update → dashboard widgets will show stale or empty data.
- X-Ray traces will be lost → distributed trace correlation is unavailable for the failure window.
- CloudWatch log-derived alarms are unaffected (they read directly from CloudWatch Logs, not from the ADOT pipeline).

**Important:** If this alarm fires, other metric-based alarms (latency, fault-rate) may show `INSUFFICIENT_DATA` rather than their true state. Do not rely on dashboards as a source of truth during an ADOT outage.

## Diagnostic Steps

1. **Open the Platform Health Dashboard** → `{environment}-platform-health`. Note that metric widgets may show gaps or stale data — this is expected when ADOT is failing. The alarm state row (which reads from CloudWatch Alarms directly) is still reliable.

2. **Run the Logs Insights query** against `/ecs/{environment}/adot-collector`:
   ```
   fields @timestamp, @logStream, level, event, exporter, errorMessage, @message
   | filter level >= 50 or event = "ADOT_EXPORT_FAILED"
   | sort @timestamp desc
   | limit 30
   ```
   Look for: `connection refused`, `context deadline exceeded`, `403 Forbidden` (IAM), or `Rate exceeded` (CloudWatch API throttling).

3. **Check ADOT sidecar health** in ECS:
   ```
   aws ecs list-tasks --cluster {cluster} --service {service}
   aws ecs describe-tasks --cluster {cluster} --tasks {task-id}
   ```
   If the sidecar container is restarting (`stoppedReason: essential container exited`), check OOM or configuration issues. Check IAM permissions on the task role for `cloudwatch:PutMetricData` and `xray:PutTraceSegments`.

## Expected Blast Radius

- Metrics and traces are lost for the duration of the outage. Application functionality is unaffected.
- Post-outage, dashboards will show a gap; alarms may flap as data resumes.

## Escalation

- Exporter failure persisting >30 min: escalate to Platform Engineering (Observability).
- IAM permission error: raise with Platform Security for task role review.
