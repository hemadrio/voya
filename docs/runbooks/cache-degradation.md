# Runbook: Redis / Cache Tier Degradation

**Runbook ID:** RB-021
**Alarms:** `CRITICAL-search-cache-unavailable`, `HIGH-search-cache-stale-serve-rate`, `audit-log-partition-maintenance-error`, `audit-log-partition-missing-next-month`
**Severity:** HIGH (search degrades but does not error); CRITICAL if RDS partition alarm fires
**SNS Topic:** platform-page (CRITICAL), platform-ticket (HIGH)
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## 1. Severity and blast radius

**Severity:** A Redis outage or cache-tier failure causes search to degrade to
direct supplier calls. Latency rises (supplier calls ~1200–2000 ms vs. cache
~10–30 ms) but search still returns HTTP 200 with valid results.

**Blast radius:**
- Search p95 latency rises. The `HIGH-search-latency-p95-warning` alarm may co-fire.
- Every search request fans out to all configured suppliers (supplier load increases).
- Responses carry `cacheAvailable: false` — traveler-visible, no error page served.
- The supplier call fan-out timeout is automatically tightened to 1,500 ms (from 2,200 ms).
- If Redis is needed for webhook idempotency dedup and is absent, the `processed_events`
  unique constraint in Postgres is the durable authority — payments remain exactly-once.

**What does NOT break during a Redis outage:**
- Booking confirmations and payment processing (Postgres is the authority).
- Webhook exactly-once delivery (Postgres unique constraint is the fallback).
- Auth sessions (Postgres-backed JWT verification).

---

## 2. Architecture thresholds (from spec — do not invent new values)

| Parameter | Value |
|-----------|-------|
| Supplier call timeout (healthy, Redis present) | 2,200 ms |
| Supplier call timeout (degraded, Redis absent) | 1,500 ms |
| Cache degradation metric | `search_cache_unavailable_total` > 0 |
| Stale serve metric | `search_cache_stale_serves_total` spike |
| Redis idempotency TTL (webhook dedup SET NX) | 72 hours |

---

## 3. Detection signals

```
ALARM: CRITICAL-search-cache-unavailable
Namespace: travel/search
Metric:    search_cache_unavailable_total
Threshold: > 0 over 5-minute window
treat_missing_data: breaching
```

```
ALARM: HIGH-search-cache-stale-serve-rate
Namespace: travel/search
Metric:    search_cache_stale_serves_total
Threshold: stale serve rate > baseline (3 of 5 datapoints)
```

**What the alarm means:** The cache repository attempted a Redis read or write
and received a connection error or timeout. The repository has automatically
degraded to direct supplier calls with tightened timeouts.

---

## 4. Triage — start from the reference identifier

**Step 1 — Resolve the reference to an X-Ray trace:**

```bash
ENV=staging
aws xray get-trace-summaries \
  --time-range-type TraceId \
  --filter-expression 'traceId = "<reference>"' \
  --query 'TraceSummaries[0].[Id, ResponseTime, Http.Status]' \
  --output table
```

**Step 2 — Filter cache error log lines:**

```bash
aws logs start-query \
  --log-group-name "/ecs/${ENV}/booking-service" \
  --start-time $(date -d '30 minutes ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, event, cacheStatus, errorMessage
    | filter event = "cache.unavailable" OR event = "cache.error"
    | sort @timestamp asc
    | limit 50'
```

**Step 3 — Check ElastiCache cluster health:**

```bash
aws elasticache describe-cache-clusters \
  --show-cache-node-info \
  --query 'CacheClusters[?contains(CacheClusterId, `'"${ENV}"'`)].{Id:CacheClusterId,Status:CacheClusterStatus,Engine:Engine}'
```

**Step 4 — Check if a Redis failover is in progress:**

```bash
aws elasticache describe-replication-groups \
  --query 'ReplicationGroups[*].{Id:ReplicationGroupId,Status:Status,AutoFailover:AutomaticFailover}' \
  --output table
```

**Fallback (trace older than X-Ray retention):**
Query CloudWatch Logs Insights on `/ecs/${ENV}/booking-service` with
`$.correlationId = "<reference>"` over an extended time range.

---

## 5. Decision tree

```
CRITICAL-search-cache-unavailable fires
  └─ Is a Redis failover in progress? (describe-replication-groups)
       ├─ YES (status: failing-over or modifying) →
       │    Wait for AWS Multi-AZ automatic recovery (typically < 60 s).
       │    Monitor CloudWatch: CacheClusterStatus → available.
       │    No manual action needed unless failover takes > 5 min.
       └─ NO (status: available) →
            └─ Is CurrConnections at the max (check CloudWatch metric)?
                 ├─ YES → connection pool exhaustion (Step 5.3)
                 └─ NO  →
                      └─ Is there a network ACL or security group change?
                           ├─ YES → revert the change (deploy-and-rollback.md)
                           └─ NO  → escalate to Head of Engineering (Section 8)
```

---

## 6. Remediation steps

### Step 1 — Verify search is still returning results (not erroring)

```bash
# Confirm the degraded path is active — response should contain cacheAvailable: false
curl -s -H "Authorization: Bearer ${TEST_TOKEN}" \
  "https://api.${ENV}.travel-platform.example/v1/flights/search?origin=LHR&destination=JFK&date=2026-09-01" \
  | jq '{status, cacheAvailable, results: (.results | length)}'
```

Expected: `{ "status": "ok", "cacheAvailable": false, "results": N }` (N > 0)

### Step 2 — Monitor ElastiCache for automatic recovery

For a Redis Multi-AZ cluster failover, AWS handles the recovery automatically.
Monitor `CacheClusterStatus` in the ElastiCache console or CloudWatch:

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/ElastiCache \
  --metric-name CurrConnections \
  --dimensions Name=CacheClusterId,Value="${ENV}-redis-cluster-001" \
  --start-time $(date -d '30 minutes ago' -u +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Average Maximum \
  --output table
```

### Step 3 — If connection pool is exhausted

```bash
# Check current connection count vs the configured max
aws elasticache describe-cache-clusters \
  --cache-cluster-id "${ENV}-redis-cluster" \
  --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[*].{Id:CacheNodeId,Status:CacheNodeStatus}' \
  --output table
```

If connections are exhausted, consider restarting the booking-service tasks to
release stale connections (tasks hold TCP connections across deployments):

```bash
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-booking-service" \
  --force-new-deployment
```

### Step 4 — Verify the alarm cleared after recovery

```bash
aws cloudwatch describe-alarms \
  --alarm-names "CRITICAL-search-cache-unavailable" "HIGH-search-cache-stale-serve-rate" \
  --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue}' \
  --output table
```

---

## 7. Verification

- [ ] `CRITICAL-search-cache-unavailable` → `OK`
- [ ] `HIGH-search-cache-stale-serve-rate` → `OK`
- [ ] `HIGH-search-latency-p95-warning` → `OK` (latency returns to baseline)
- [ ] `GET /v1/flights/search` returns `cacheAvailable: true` in the response
- [ ] ElastiCache `CacheClusterStatus` → `available`
- [ ] Search p95 returns to < 3,000 ms baseline

---

## 8. Rollback

Redis degradation does not require a code rollback — the degraded path is a
built-in architectural safety net, not a deployed change. If a recent deployment
introduced a cache connection regression:

```bash
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-booking-service" \
  --task-definition "${ENV}-booking-service:<PREVIOUS_REVISION>" \
  --force-new-deployment

aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-booking-service"
```

**Rollback target:** previous immutable task definition revision (n-1).
**Time to recover:** under 5 minutes via the previous task definition revision procedure.

---

## 9. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Redis failover > 5 min | Platform On-Call | PagerDuty | Immediate |
| Latency p95 > 5s sustained | Head of Engineering | `#incidents` + page | 15 min |
| Connection exhaustion | Platform On-Call | `#platform-ops` | 15 min |

---

## 10. Post-incident evidence capture (SOC 2)

1. Export cache error log lines from `/ecs/${ENV}/booking-service` for the alarm window.
2. Export ElastiCache CloudWatch metrics (CurrConnections, Evictions, CPUUtilization).
3. Record: duration of cache unavailability, traveler-facing impact (elevated latency
   confirmed via CloudWatch), resolution method (auto-recovery vs. manual).
4. Archive to `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-cache-degradation/`.
