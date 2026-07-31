# Runbook: Search Latency Breach

**Alarms:** `HIGH-search-latency-p95-warning`, `CRITICAL-search-latency-p95-hard`, `HIGH-search-cache-latency-p95-warning`
**Severity:** CRITICAL (hard) / HIGH (warning / cache)
**SNS Topic:** platform-page (hard) / platform-ticket (warning, cache)

## Signal Meaning

| Alarm | Threshold | Meaning |
|---|---|---|
| `search-latency-p95-warning` | p95 > 3000 ms | SLO degradation in progress; 2 of 5 datapoints |
| `search-latency-p95-hard` | p95 > 5000 ms | Hard budget breach; 3 of 5 datapoints |
| `search-cache-latency-p95-warning` | p95 > 180 ms | Cache-hit path degraded; may indicate Redis outage |

The cache-hit alarm at 180 ms **will fire legitimately during a Redis outage** when the service falls back to direct supplier calls. Check the Redis alarm before acting on this one — degraded mode is expected behaviour, not a bug.

## Diagnostic Steps

1. **Open the Search Journey Dashboard** in CloudWatch → `{environment}-search-journey`. Confirm whether all three percentile lines (p50, p95, p99) are elevated (platform-wide) or only p95/p99 (long-tail outliers). A separation between p50 and p95 points to a supplier latency tail rather than a platform regression.

2. **Run the Logs Insights query** against `/ecs/{environment}/search-service`:
   ```
   fields @timestamp, correlationId, service, supplier, latencyMs, event, @message
   | filter event = "SEARCH_COMPLETED" or event = "SUPPLIER_TIMEOUT"
   | stats avg(latencyMs) as avgMs, pct(latencyMs, 95) as p95Ms by supplier
   | sort p95Ms desc
   | limit 20
   ```
   Identify whether a single supplier is responsible (502/504) or all suppliers are slow (500 platform fault).

3. **Check the Redis alarm** (`aws cloudwatch describe-alarms --alarm-name-prefix "redis-"`) to determine if cache degradation is the root cause. If Redis is in alarm, the cache-hit latency alarm is expected — focus on restoring Redis rather than the search path.

## Expected Blast Radius

- Search journey p95 breach: all new search requests will be slow. Cached/pre-warmed results are unaffected.
- During Redis outage: all search requests fall back to supplier calls; expect 5–10× latency increase.

## Escalation

- 15 min without mitigation: escalate to Search Service on-call lead and Supplier Integration team.
- If single supplier: contact supplier SRE contact listed in `docs/suppliers/` and consider circuit-breaking the supplier in the search-service configuration.
