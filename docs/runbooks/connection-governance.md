# Connection Governance Runbook

## Overview

All PostgreSQL traffic flows through RDS Proxy with IAM authentication and
TLS required.  No service may hold a direct RDS endpoint in any environment.
Each request-serving ECS task is limited to `connection_limit=5`.  The migration
task and purge worker each have reserved allocations.

Architecture decision: direct Prisma connections and PgBouncer sidecars were
formally rejected because they lack per-service ceilings and do not survive a
Multi-AZ failover (which protects the 1-hour RTO target).

See also: `infra/terraform/modules/rds-proxy/connection-budget.md`

---

## CloudWatch Alarms

| Alarm | Metric | Threshold | Action |
|---|---|---|---|
| `*-rds-proxy-borrow-latency` | `DatabaseConnectionsBorrowLatency` | > 1,000 ms avg (2 periods) | See §Borrow Latency Response |
| `*-rds-proxy-client-connections-failed` | `ClientConnectionsSetupFailed` | > 0 sum (2 periods) | See §Client Connection Failures |
| `*-rds-proxy-connection-utilisation` | `DatabaseConnections` | > 80% of budget (3 periods) | See §Connection Utilisation Response |
| `*-prisma-pool-timeout` | `travel-platform/PrismaPoolTimeout` | > 0 sum (2 periods) | See §Prisma Pool Timeout Response |

All alarms route to the `<env>-travel-platform-alarms` SNS topic.

---

## §Borrow Latency Response

**What it means:** The proxy is spending > 1 s finding a server-side (pinned)
connection.  Services are queuing database work.  This is a warning — requests
are not yet failing.

**Immediate actions:**

1. Check `DatabaseConnections` in CloudWatch → confirm utilisation is below
   the alarm threshold (288 for the current budget).
2. Check ECS service desired counts against the connection budget table:
   ```bash
   aws ecs describe-services --cluster <env>-travel-platform \
     --services booking-service user-service auth-service \
     --query "services[].{name:serviceName,running:runningCount,desired:desiredCount}"
   ```
3. If a recent scale-out event increased task counts beyond budget, scale down
   the lowest-priority service (`reporting-service` → `itinerary-service`).
4. If a migration task is running, confirm it finishes within its reserved
   window (it holds a maximum of 10 connections).

**Escalation:** If latency exceeds 5 s or the alarm does not clear within
10 minutes, escalate to the on-call DB engineer.

---

## §Client Connection Failures

**What it means:** The proxy is refusing new client connections.  Services
cannot reach the database.  This is a service-impact event.

**Immediate actions:**

1. Check proxy endpoint reachability:
   ```bash
   aws rds describe-db-proxies --db-proxy-name <env>-travel-platform \
     --query "DBProxies[].{status:Status,endpoint:Endpoint}"
   ```
   Status should be `available`.

2. Check `ClientConnectionsSetupFailedReason` metric (dimension: ProxyName)
   for the failure type (IAMAuth, TLSHandshake, ConnectionBudget).

3. For `ConnectionBudget` failures — the proxy has exhausted `max_connections_percent`.
   Emergency: increase `max_connections_percent` in Terraform and apply:
   ```bash
   cd infra/terraform/envs/<env>
   terraform apply -target=module.rds_proxy
   ```
   Then review the budget to understand the cause.

4. For `IAMAuth` failures — check ECS task role policies:
   ```bash
   aws iam list-attached-role-policies --role-name <env>-<service>-task
   ```
   Ensure the `<env>-<service>-rds-connect` policy is attached.

---

## §Connection Utilisation Response

**What it means:** Server-side connections are at > 80% of the budget ceiling.
The migration task or purge worker may be starved of its reserved 10 connections.

**Immediate actions:**

1. Identify which service is over-consuming:
   ```bash
   aws cloudwatch get-metric-data --metric-data-queries '[
     {"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/RDS","MetricName":"DatabaseConnections","Dimensions":[{"Name":"ProxyName","Value":"<env>-travel-platform"}]},"Period":60,"Stat":"Maximum"}}
   ]' --start-time <ISO8601> --end-time <ISO8601>
   ```

2. Cross-reference with ECS task counts and the connection budget in
   `infra/terraform/modules/rds-proxy/connection-budget.md`.

3. To add headroom (raises the proxy ceiling — requires Terraform apply):
   ```hcl
   # infra/terraform/envs/<env>/main.tf
   # Increase max_connections_percent and update connection-budget.md
   max_connections_percent = 25  # was 20
   ```
   Run `terraform apply -target=module.rds_proxy` (requires PR approval).

**Ceiling change checklist:**
- [ ] Recompute the budget table in connection-budget.md
- [ ] Confirm the new total fits within db.r6g.large max_connections (1,802)
- [ ] Update the `db_connection_ceiling` local in monitoring.tf comment
- [ ] PR reviewed by a second engineer; production requires security sign-off

---

## §Prisma Pool Timeout Response

**What it means:** A service's Prisma client waited longer than `pool_timeout`
(10 s) for a connection.  The request received a retryable error envelope.

**Immediate actions:**

1. Identify which service is logging pool timeouts:
   ```bash
   # CloudWatch Logs Insights
   fields @timestamp, service, message
   | filter message like /pool timeout/
   | sort @timestamp desc
   | limit 50
   ```

2. Confirm `connection_limit=5` is present in the service DATABASE_URL:
   ```bash
   aws ecs describe-task-definition --task-definition <env>-<service> \
     --query "taskDefinition.containerDefinitions[].environment[?name=='DATABASE_URL']"
   ```
   The URL must contain `connection_limit=5&pool_timeout=10`.
   (Passwords are stored in Secrets Manager; this query returns the URL template.)

3. If connection_limit is correct, the service is receiving more concurrent
   requests than 5 connections can serve.  Scale the service down or
   investigate slow queries holding connections.

---

## Raising the Per-Service Ceiling

The `connection_limit=5` ceiling is enforced by a startup assertion in
`packages/config/src/databaseUrl.ts`.  To raise it for a specific service:

1. Recompute the connection budget in `connection-budget.md`.
2. Update `MAX_SERVICE_CONNECTION_LIMIT` in `packages/config/src/databaseUrl.ts`
   (or pass `ceiling` override to `assertConnectionLimit()`).
3. Rebuild the service image and deploy.
4. Verify the alarm threshold remains below 80% of the new total.

Do **not** raise the ceiling without recomputing the budget — the whole point
of the proxy is that the total connection count stays bounded.

---

## Rollback to Previous Task Definition

If a proxy-related change causes service degradation:

```bash
# List recent task definition revisions
aws ecs list-task-definitions --family-prefix <env>-<service> --sort DESC

# Roll back to a previous revision
aws ecs update-service \
  --cluster <env>-travel-platform \
  --service <env>-<service> \
  --task-definition <env>-<service>:<prev-revision>
```

The `lifecycle { ignore_changes = [task_definition] }` block in the ECS
service Terraform ensures Terraform does not overwrite this rollback on the
next apply.

---

## Multi-AZ Failover Behaviour

During an RDS Multi-AZ failover:

1. In-flight transactions on the old primary will fail (connection reset).
2. RDS Proxy detects the failover and reconnects to the new primary.
3. New client connections succeed through the proxy without service restart.
4. Expected error window: 20–40 seconds (observed in WO-076 failover exercise).
5. Errors surface as retryable envelopes — clients should retry with exponential
   back-off using the `Retry-After` header.

Do **not** restart ECS services during a failover — the proxy handles
reconnection automatically.  A manual restart extends the error window.

---

## Forced Failover Test Procedure (Quarterly)

1. Start the load-test harness at 300 rps.
2. Initiate failover:
   ```bash
   aws rds reboot-db-instance \
     --db-instance-identifier <env>-travel-platform \
     --force-failover
   ```
3. Record from CloudWatch and X-Ray:
   - Error window start/end (5xx spike)
   - `DatabaseConnectionsBorrowLatency` peak
   - Recovery time (latency returns to baseline)
4. Acceptable outcome: recovery < 60 s, zero manual intervention, all
   connections resume without service restart.
5. Attach the CloudWatch screenshot and k6 results to the quarterly runbook
   review issue.
