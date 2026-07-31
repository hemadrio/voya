# Search Degradation Runbook

**Runbook ID:** RB-010
**Epic:** multi-supplier-search
**Owner:** Platform On-Call
**Last reviewed:** 2026-Q3

---

## Purpose

This runbook covers the degraded-mode behaviour of the three search endpoints
(`/v1/flights/search`, `/v1/hotels/search`, `/v1/cars/search`) during a Redis
outage or supplier failure. It provides symptom-to-signal mapping, step-by-step
recovery procedures, and a quarterly degradation drill specification.

**Key guarantee:** a Redis outage never produces an error response. The cache
repository degrades to direct supplier calls, tightens the fan-out timeout from
2200 ms to 1500 ms, and labels every response `cacheAvailable: false`. Search
continues to return HTTP 200.

---

## Symptom-to-Signal Mapping

| Observable symptom | Primary signal | Dashboard widget | Alarm |
|---|---|---|---|
| Search p95 latency spikes above 3 s | `SearchResponseP95` → p95 warning threshold | "Search Latency" row 1 | `HIGH-search-latency-p95-warning` |
| Search p95 latency above 5 s | `SearchResponseP95` → p95 hard threshold | "Search Latency" row 1 | `CRITICAL-search-latency-p95-hard` |
| Responses labelled `cacheAvailable: false` | `search_cache_unavailable_total` > 0 | "Cache Unavailability" row 4 | `CRITICAL-search-cache-unavailable` |
| Stale prices being served | `search_cache_stale_serves_total` spike | "Cache Hit/Miss/Stale Rate" row 4 | `HIGH-search-cache-stale-serve-rate` |
| Supplier breaker open | `SupplierBreakerTransitionsTotal` > 0 | "Supplier Breaker Transitions" row 4 | `HIGH-search-supplier-breaker-open` |
| Non-bookable illustrative offer in response | `illustrative_offers_served_total` > 0 | "Illustrative Offers" row 5 | `CRITICAL-search-illustrative-offers-served` |
| All suppliers returning empty results | `SearchFaultRate` spike with empty-state responses | "Search Fault Rate" row 2 | `CRITICAL-search-fault-rate` |

---

## Section 1: Redis / Cache Outage

### Detection

```
ALARM: CRITICAL-search-cache-unavailable
Metric: search_cache_unavailable_total > 0 over 5 minutes
```

The alarm fires when at least one Redis operation fails (read or write) and the
cache repository's health state degrades to `UNAVAILABLE`.

### Symptom progression

1. `search_cache_unavailable_total` counter begins incrementing.
2. `cacheAvailable: false` appears in search API responses — clients see valid
   offers sourced directly from suppliers.
3. Search p95 latency rises because every request hits suppliers (supplier calls
   take ~1200–2000 ms vs. ~10–30 ms for a cache hit).
4. `search_cache_p95_warning` breaches — this is **expected** during a Redis
   outage and is documented in the alarm description.

### Impact assessment

- **Client impact:** search works, but all responses reflect live pricing. No
  serving of stale prices. Latency is higher.
- **Supplier load:** every request fans out to all configured suppliers. Watch
  for supplier rate-limiting signals (`SupplierRejectedRequestError` in logs).
- **Timeout:** fan-out timeout is automatically tightened to
  `supplier_timeout_degraded_ms` (1500 ms) to preserve the overall latency
  budget. The healthy value (2200 ms) resumes automatically when Redis recovers.

### Recovery steps

1. **Verify Redis cluster health.**
   - AWS ElastiCache console: check `CacheClusterStatus`, `EngineCPUUtilization`,
     `Evictions`, and `CurrConnections`.
   - If a node is in `modifying` or `failing over` state, wait for AWS to
     complete the failover automatically (typically < 60 s for Redis cluster mode
     enabled with Multi-AZ).

2. **Check for connection exhaustion.**
   - Search service logs: `grep 'Redis write error\|Redis read error'` —
     repeated errors with `ECONNREFUSED` indicate the Redis connection pool is
     exhausted or the endpoint is unreachable.
   - Verify the Redis endpoint DNS resolves correctly:
     ```sh
     nslookup <elasticache-primary-endpoint>
     ```

3. **Verify service-side health state recovery.**
   - The cache repository's `CacheHealthState` automatically probes Redis every
     `recoveryProbeIntervalMs` (30 s by default) while in `UNAVAILABLE` state.
   - After one successful Redis operation, health state resets to `HEALTHY`
     within the next probe cycle.
   - Watch `search_cache_unavailable_total`: when it stops incrementing, Redis
     has recovered. The alarm should self-resolve within one evaluation period (5
     min).

4. **Force recovery (emergency only).**
   - If the Redis endpoint itself has changed (e.g., failover to a new replica
     endpoint), update the `REDIS_URL` environment variable and recycle the ECS
     task:
     ```sh
     aws ecs update-service --cluster travel-prod \
       --service search-service \
       --force-new-deployment
     ```
   - Confirm `CacheHealthState` recovers after task recycle by watching
     `search_cache_unavailable_total` drop to zero.

---

## Section 2: Supplier Token Expiry Recovery

### Detection

Supplier calls begin failing with `SUPPLIER_REJECTED` (HTTP 422) or the
`SupplierBreakerTransitionsTotal` alarm fires.

Search service logs:
```
{"level":"error","supplier":"AMADEUS","outcome":"FAILED","msg":"Supplier call failed during fan-out"}
```

### Recovery

1. **Identify the expiring token.**
   - Check the supplier adapter's token provider (e.g.,
     `AmadeusTokenProvider`): tokens typically expire after 30 minutes.
   - Log query: `grep 'token.*expir\|TokenProvider\|401'` in the search service
     log group.

2. **Rotate the supplier API key (if token fetch fails).**
   - Retrieve the current credential from AWS Secrets Manager:
     ```sh
     aws secretsmanager get-secret-value \
       --secret-id travel/<env>/amadeus-api-key
     ```
   - If the credential itself is expired, rotate via the supplier portal and
     update Secrets Manager. Force a task recycle to pick up the new value.

3. **Verify recovery.**
   - Watch `SupplierBreakerTransitionsTotal` — once the supplier starts
     returning 200s, the breaker resets on the next successful call.
   - Confirm search API responds with `supplierOutcomes[*].outcome: "available"`.

---

## Section 3: Circuit Breaker Reset

### Detection

```
ALARM: HIGH-search-supplier-breaker-open
Metric: SupplierBreakerTransitionsTotal > 0
```

### What the circuit breaker does

The supplier circuit breaker (WO-029) counts consecutive failures per supplier.
After the configured threshold, it stops calling that supplier (outcome:
`SKIPPED_CIRCUIT_OPEN`) and attempts recovery after a probe interval.

### Manual reset

1. **Check which supplier triggered the open.**
   - Log query: `grep 'SKIPPED_CIRCUIT_OPEN'` — the `supplier` field identifies
     the affected adapter.

2. **Verify the supplier is actually responding.**
   - External health check or supplier status page.
   - If the supplier has recovered, the breaker will reset automatically after
     its recovery probe interval (typically 30–60 s).

3. **Force reset (ECS task recycle).**
   - The breaker state is in-memory per task replica. Recycling the task resets
     it immediately:
     ```sh
     aws ecs update-service --cluster travel-<env> \
       --service search-service \
       --force-new-deployment
     ```
   - After recycle, monitor supplier outcomes in real time:
     ```sh
     aws logs tail /ecs/<env>/search-service --follow \
       | grep supplierOutcomes
     ```

4. **Configuration-based threshold reduction.**
   - If the supplier is consistently unreliable, reduce the breaker threshold in
     the search service configuration (`BREAKER_FAILURE_THRESHOLD`) and redeploy
     to move to a tighter open/half-open cycle.

---

## Section 4: Cache-Outage Degradation Verification

Use this procedure to confirm the degradation path is functioning correctly
**during an ongoing Redis outage** (or drill — see Section 5).

### Verification checklist

```
[ ] 1. search_cache_unavailable_total is incrementing
[ ] 2. Search endpoints return HTTP 200 (not 500)
[ ] 3. Response body includes cacheAvailable: false
[ ] 4. Supplier offers are present in the response (not empty)
[ ] 5. Search latency has risen (expected — supplier path, not cache)
[ ] 6. search_cache_p95_warning alarm may be in ALARM — this is expected
[ ] 7. CRITICAL-search-cache-unavailable alarm is in ALARM
```

### Quick API verification

```sh
# Flight search — verify 200 + cacheAvailable: false
curl -s -X POST https://<api-host>/v1/flights/search \
  -H "Content-Type: application/json" \
  -d '{"departureAirport":"LHR","arrivalAirport":"JFK","departureDate":"<future-ISO>","passengers":1,"seatClass":"ECONOMY","currency":"USD"}' \
  | jq '{status: .httpStatus, cacheAvailable: .cacheAvailable, offerCount: (.offers | length)}'

# Expected: {"status": 200, "cacheAvailable": false, "offerCount": <N>}
```

---

## Section 5: Quarterly Degradation Drill

> **⚠️ STAGING ONLY — NEVER PRODUCTION ⚠️**
>
> The degradation drill must only be executed against the staging environment.
> It involves deliberately stopping or network-isolating the Redis cluster. This
> procedure must never be run against production.

### Purpose

Validate that the degradation path operates as designed:
- Search continues to return HTTP 200 during a Redis outage.
- `cacheAvailable: false` is present in responses.
- Latency rises but stays within the p95 5.0 s hard alarm.
- `search_cache_unavailable_total` increments correctly.
- After Redis recovery, `CacheHealthState` resets to `HEALTHY` within one probe
  cycle.

### Pre-drill checklist

```
[ ] Confirm environment is staging (check AWS_ENV or cluster name)
[ ] Notify the team in #platform-on-call that a drill is starting
[ ] Open the search staging dashboard
[ ] Note current baseline latency and cache-hit rate
[ ] Confirm no active incidents in production
```

### Drill procedure (staging only)

**Step 1 — Baseline capture**

```sh
# Record current metric values (staging CloudWatch)
aws cloudwatch get-metric-statistics \
  --namespace travel/search \
  --metric-name search_cache_unavailable_total \
  --statistics Sum \
  --period 300 \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
```

**Step 2 — Stop Redis (Docker Compose local / staging ElastiCache)**

*Docker Compose (local staging):*
```sh
docker compose stop redis
# or network blackhole:
docker network disconnect travel_default redis
```

*Staging ElastiCache (must have break-glass access):*
```sh
# Apply a security group rule to block the Redis port
aws ec2 authorize-security-group-ingress \
  --group-id <sg-id> \
  --protocol tcp --port 6379 --source-group <sg-id> --description "drill-block"
# NOTE: revert immediately after drill is complete
```

**Step 3 — Execute search requests**

```sh
for i in $(seq 1 10); do
  curl -s -X POST https://<staging-api-host>/v1/flights/search \
    -H "Content-Type: application/json" \
    -d '{"departureAirport":"LHR","arrivalAirport":"JFK","departureDate":"2099-06-15T12:00:00.000Z","passengers":1,"seatClass":"ECONOMY","currency":"USD"}' \
    | jq '{status: .httpStatus, cacheAvailable: .cacheAvailable, offers: (.offers | length)}'
  sleep 2
done
```

**Step 4 — Verify degraded-mode observations**

```
Expected observations:
  ✓ All 10 requests return HTTP 200
  ✓ All responses include cacheAvailable: false
  ✓ Offers are present (sourced from live suppliers)
  ✓ search_cache_unavailable_total is incrementing in CloudWatch
  ✓ CRITICAL-search-cache-unavailable alarm is in ALARM state (staging)
  ✓ p95 latency has risen (expected — 1200-2000ms supplier path)
```

**Step 5 — Restart Redis and verify recovery**

*Docker Compose:*
```sh
docker compose start redis
# or re-connect:
docker network connect travel_default redis
```

*Staging ElastiCache:*
```sh
# Revoke the blocking security group rule
aws ec2 revoke-security-group-ingress \
  --group-id <sg-id> \
  --protocol tcp --port 6379 --source-group <sg-id>
```

Wait 30–60 s (one probe interval) then verify:
```sh
# Confirm cacheAvailable returns to true
curl -s -X POST https://<staging-api-host>/v1/flights/search \
  ... | jq '.cacheAvailable'
# Expected: true
```

**Step 6 — Post-drill verification**

```
[ ] CRITICAL-search-cache-unavailable alarm returned to OK
[ ] cacheAvailable: true in search responses
[ ] search_cache_unavailable_total stopped incrementing
[ ] No lingering p95 breach after cache recovery
[ ] Notify #platform-on-call that drill is complete
```

### Drill recording template

| Date | Operator | Time to degrade | Time to recover | Observations |
|------|----------|-----------------|-----------------|--------------|
| YYYY-MM-DD | @name | ~Xs | ~Xs | e.g., "cacheAvailable: false confirmed, p95 rose to 2.1s, recovery in 32s after Redis restart" |

---

## Reference: Key Metrics and Thresholds

| Metric | Namespace | Description |
|--------|-----------|-------------|
| `search_cache_unavailable_total` | `travel/search` | Redis operations that failed and were converted to no-op |
| `search_cache_stale_serves_total` | `travel/search` | Stale-but-served cache hits that triggered background refresh |
| `search_cache_hits_total` | `travel/search` | Fresh cache hits |
| `search_cache_misses_total` | `travel/search` | Cache misses (key absent or expired) |
| `SupplierBreakerTransitionsTotal` | `travel/search` | Supplier circuit breaker open/half-open transitions |
| `illustrative_offers_served_total` | `travel/search` | Non-bookable illustrative offers served |
| `SearchLatencyByCategory` | `travel/search` | p95 latency histogram by search category |

| Threshold | Value |
|-----------|-------|
| Supplier timeout — healthy | 2200 ms |
| Supplier timeout — degraded (Redis unavailable) | 1500 ms |
| Search p95 warning | 3000 ms |
| Search p95 hard | 5000 ms |
| Stale-serve rate alarm | 20% |
| Probe interval (UNAVAILABLE → retry) | 30 s |
| Consecutive failures to degrade | 3 |

---

## Related Runbooks

- [search-latency-breach.md](./search-latency-breach.md)
- [illustrative-result-exposure.md](./illustrative-result-exposure.md)
- [adot-collector-failure.md](./adot-collector-failure.md)
- [availability-error-budget-burn.md](./availability-error-budget-burn.md)
