# Load-Test Harness

k6-based load-test harness for the travel platform.  Exercises the search and
checkout journeys through the API gateway with realistic fixture payloads.
Supplier calls are stubbed at the gateway level so the tests isolate the data
tier (PostgreSQL via RDS Proxy) and avoid external API costs.

## R9 Exit Criterion

> At 2× the 300 rps platform peak (600 rps sustained) there must be zero
> connection-pool exhaustion errors, zero database connection refusals and no
> unhandled 5xx attributable to the data tier.

## Prerequisites

Install k6:

```bash
# macOS
brew install k6
# Linux / CI
curl -s https://dl.k6.io/key.gpg | sudo apt-key add -
echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Running Scenarios

```bash
# Baseline: 300 rps search + checkout (warm-up, then sustained 5 min)
k6 run --env TARGET_BASE_URL=https://staging.travel-platform.example.com \
       --env SCENARIO=search \
       scenarios/search.js

# R9 validation: 600 rps (2× peak) sustained 10 min
k6 run --env TARGET_BASE_URL=https://staging.travel-platform.example.com \
       --env RATE=600 \
       --env DURATION=600s \
       scenarios/search.js

# Checkout journey
k6 run --env TARGET_BASE_URL=https://staging.travel-platform.example.com \
       scenarios/checkout.js

# Failover scenario: run alongside an RDS Multi-AZ failover reboot
# Initiate from another terminal:
#   aws rds reboot-db-instance --db-instance-identifier staging-travel-platform --force-failover
k6 run --env TARGET_BASE_URL=https://staging.travel-platform.example.com \
       --env RATE=300 \
       --env DURATION=300s \
       scenarios/search.js
```

## CI Integration

The harness runs in CI via the `load-test` job (runs post-deploy to staging):

```yaml
# .forge/pipeline.yml excerpt (not in this repo — managed by Forge pipeline)
load-test:
  runs-after: deploy-staging
  command: >
    k6 run
      --env TARGET_BASE_URL=$STAGING_BASE_URL
      --env RATE=600
      --env DURATION=300s
      --out json=results/k6-r9.json
      load-tests/scenarios/search.js
  thresholds:
    - http_req_failed < 0.001     # < 0.1% error rate
    - http_req_duration p(95) < 3000  # search p95 < 3 s
    - db_pool_errors < 1          # zero pool exhaustion
```

## Fixtures

Fixture payloads are committed under `load-tests/fixtures/` so the harness
runs without external suppliers.  The gateway stubs supplier backends when
`X-Load-Test: true` is present in the request header.

## Metrics

| Metric | Threshold | Journey |
|---|---|---|
| `http_req_duration p(95)` | < 3,000 ms | Search (cache miss) |
| `http_req_duration p(95)` | < 5,000 ms | Checkout acknowledgement |
| `http_req_failed` | < 0.1% | All journeys |
| `db_pool_errors` (custom) | 0 | All journeys |
| Connection recovery after failover | < 60 s | Failover scenario |
