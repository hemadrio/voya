# RDS Proxy Connection Budget

## Instance Baseline

| Parameter | Value |
|---|---|
| RDS instance class | `db.r6g.large` |
| RAM | 16 GiB (17,179,869,184 bytes) |
| `max_connections` formula | `LEAST({DBInstanceClassMemory / 9531392}, 5000)` |
| Computed `max_connections` | `LEAST(floor(17179869184 / 9531392), 5000)` = **1,802** |

## Per-Service Connection Limit Policy

Every service Prisma client is configured with `connection_limit=5`.
Each ECS task opens at most 5 proxy client connections.
The proxy multiplexes many client connections onto fewer server (pinned) connections.

## Service Connection Budget at Maximum Scale

Services that connect to PostgreSQL (via the proxy):

| Service | Max Tasks | Per-task limit | Max Client Connections |
|---|---|---|---|
| auth-service | 8 | 5 | 40 |
| user-service | 8 | 5 | 40 |
| booking-service | 8 | 5 | 40 |
| payment-service | 8 | 5 | 40 |
| notification-service | 8 | 5 | 40 |
| itinerary-service | 4 | 5 | 20 |
| reporting-service | 4 | 5 | 20 |
| **Total request-serving** | | | **240** |

_Note: api-gateway, flight-service, hotel-service, car-service, and ai-service
do not access PostgreSQL directly; they are excluded from the budget._

## Operational Reservations

| Role | Tasks | Per-task limit | Reserved Connections |
|---|---|---|---|
| migration-task | 1 | 10 | 10 |
| purge-worker | 2 | 5 | 10 |
| **Total reserved** | | | **20** |

The migration task uses a higher per-connection limit (10) because it runs a
single instance and needs headroom for concurrent schema migrations.

## Total and Proxy Ceiling

```
Total planned connections = 240 (request-serving) + 20 (reserved) = 260
Max connections overhead  = 260 / 1802 = 14.4%
MaxConnectionsPercent     = 20%  (rounds up, gives ~100 connections headroom)
```

Setting `max_connections_percent = 20` allows the proxy to open up to:

  `floor(1802 × 20%) = 360 server-side connections`

Headroom above total planned: `360 − 260 = 100 connections` (~38% buffer)
This headroom absorbs burst scale-outs before the utilisation alarm fires.

## Proxy Tuning Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `max_connections_percent` | 20 | Fits all services at max scale + 38% headroom |
| `max_idle_connections_percent` | 1 | Aggressively reclaim idle slots for operational tasks |
| `connection_borrow_timeout` | 120 s | Allows borrow-latency alarm to fire before hard errors |
| Prisma `connection_limit` | 5 (services) / 10 (migration) | Policy ceiling; startup assertion enforces it |
| Prisma `pool_timeout` | 10 s | Surfaces as retryable error before 120 s borrow timeout |

## Utilisation Alarm Threshold

CloudWatch alarm fires at 80% of the proxy server-connection ceiling:

  `alarm_threshold = floor(360 × 80%) = 288 connections`

This gives the on-call team ~72 connections of advance warning before the
migration task or purge worker risks being starved of its reserved allocation.

## Rollback

If a service-count change increases total connections beyond the budget:

1. Increase `max_connections_percent` in Terraform (requires proxy update ~1 min).
2. Alternatively, reduce `desired_count` for a lower-priority service.
3. Never raise Prisma `connection_limit` above 5 for request-serving tasks
   without recomputing the budget and updating this document.

See `docs/runbooks/connection-governance.md` for alarm response procedures.
