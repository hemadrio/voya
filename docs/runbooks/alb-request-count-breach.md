# Runbook: ALB RequestCountPerTarget Breach (Step-Scaling Trigger)

**Alarm:** `INFO-alb-request-count-step-scaling`
**Severity:** INFO
**SNS Topic:** platform-info

## Signal Meaning

ALB RequestCountPerTarget has exceeded 1000 requests per target over a 2-minute evaluation window. This alarm is the **step-scaling trigger** for the application tier ECS services.

Under normal operations, this alarm firing and resolving is expected during traffic spikes — the autoscaling policy will add capacity in response. This runbook is for investigating cases where:

- The alarm fires but new tasks fail to start (capacity ceiling, image pull failure).
- The alarm fires repeatedly without additional capacity being added (autoscaling policy misconfiguration).
- Traffic is disproportionately hitting a subset of targets (uneven load balancing).

## Diagnostic Steps

1. **Open the Checkout and Payment Dashboard** → `{environment}-checkout-payment-journey`. Check the ALB TargetResponseTime p95 widget. If latency is also elevated, the autoscaling response is lagging behind traffic growth.

2. **Run the Logs Insights query** against `/ecs/{environment}/booking-service` for the spike window:
   ```
   fields @timestamp, @logStream, correlationId, path, latencyMs
   | filter latencyMs > 1000
   | stats count(*) as slowRequests, avg(latencyMs) as avgMs by path
   | sort slowRequests desc
   | limit 10
   ```

3. **Check ECS service autoscaling events**:
   ```
   aws application-autoscaling describe-scaling-activities \
     --service-namespace ecs \
     --resource-id service/{cluster}/{service}
   ```
   Confirm that scaling activity was triggered. If `FAILED` events appear, check IAM permissions on the autoscaling role and ECS cluster capacity.

## Expected Blast Radius

- If autoscaling responds successfully: brief latency increase until new tasks register with the ALB (typically 30–60 seconds).
- If autoscaling fails: sustained latency increase and possible 5xx fault-rate alarm.

## Escalation

- Autoscaling failing to add capacity: escalate to Platform Engineering (Infrastructure).
- Image pull failures (ECR throttling or missing image): escalate to the team that owns the service.
