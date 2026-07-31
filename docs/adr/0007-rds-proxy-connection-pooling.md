# ADR-0007: RDS Proxy over PgBouncer for Per-Service Connection Pooling

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Infrastructure, Security
**Owner:** Infrastructure

---

## Context

The platform runs nine ECS Fargate services, each with its own Prisma client that opens a connection pool to PostgreSQL. At steady state each service runs a minimum of three tasks; during a 3× scale event tasks can reach 20 per search service. Without a connection pooler, scaling compute exhausts the `max_connections` setting on the RDS `db.r6g.large` instance (~400 connections), causing connection refused errors before CPU is a constraint.

The platform's NFR states: "Connection pooler with per-service connection ceilings so scaling compute cannot exhaust the data tier." Only four services (auth, user, booking, payment) need direct database access; the others use Redis or the queue.

Additionally, Multi-AZ failover must not cause unbounded connection resets. Direct Prisma connections maintain a pool per task; after an AZ failover the primary endpoint changes and every pool must reconnect. A pooler that proxies the connection hides the failover from application code and preserves `max_connections` budget.

---

## Decision

Use AWS RDS Proxy as the connection pooler for all four database-connected services. Each service's Prisma `DATABASE_URL` targets the service-specific RDS Proxy endpoint (not the RDS writer endpoint directly). The Prisma `connection_limit` is set to 5 per service task, enforced via the `?connection_limit=5` query parameter in the `DATABASE_URL`.

---

## Rationale

RDS Proxy is managed by AWS, requires no sidecar container, and authenticates using IAM task-role credentials — no Postgres password needs to be stored in Secrets Manager beyond the initial rotation. It survives Multi-AZ failover by maintaining the pooled connections to the new primary while clients reconnect to the Proxy endpoint (unchanged DNS), reducing the effective reconnect window from ~60 s (client direct) to ~2 s (proxy-managed). The per-service `connection_limit=5` cap means even at 20 tasks per service the peak connection count is 100 connections, well within the `db.r6g.large` limit.

PgBouncer as a sidecar was evaluated. It provides equivalent pooling semantics but requires a container per ECS task, additional configuration management, and a separate secret rotation path for the Postgres password it holds. RDS Proxy absorbs all of this at managed-service pricing.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Direct Prisma connections (no pooler) | At 20 tasks × 4 services × default Prisma pool size of 10 = 800 connections, which exhausts `db.r6g.large` max_connections; rejected outright |
| PgBouncer sidecar per ECS task | Each task needs a sidecar container, a PgBouncer config file, and a Postgres password injected via Secrets Manager; failover protection requires `server_check_query` and `reconnect_timeout` tuning; RDS Proxy provides all this as a managed service with no sidecar overhead |
| pgpool-II | More complex than PgBouncer; designed for read/write splitting and replication scenarios; adds operational complexity not warranted for a single-writer RDS setup |
| Session-mode PgBouncer | Transaction-mode pooling (used by RDS Proxy) requires no server-side state per session, allowing higher multiplexing ratios; session mode provides no benefit for Prisma's short-lived query patterns |

---

## Consequences

**Positive:**
- Scaling compute from 3 to 20 tasks does not exhaust PostgreSQL connections.
- Multi-AZ failover is transparent to application code; Prisma reconnects to the proxy endpoint without DNS change.
- IAM task-role authentication eliminates a Postgres password from the `DATABASE_URL` environment variable.
- Per-service connection ceiling (5 per task) provides predictable capacity planning.

**Negative / Trade-offs:**
- RDS Proxy adds ~1–2 ms to each query round-trip (proxy overhead); this is within the 8 ms Zod validation + 80 ms DB write budget for checkout.
- RDS Proxy does not support all PostgreSQL protocol features (e.g., `SET LOCAL` statements in transaction mode); prepared statements used by Prisma are pinned to a server connection, which reduces the effective multiplexing ratio slightly.
- Cost: RDS Proxy charges per vCPU of the RDS instance; this is approximately 35 % of the RDS instance cost per hour.

**Neutral / Notes:**
- The `connection_limit=5` value is the result of the capacity calculation: 20 tasks × 5 = 100 peak connections per service, four services = 400 max, within the `db.r6g.large` limit of ~400.
- The RDS Proxy endpoint URL is injected at runtime from Secrets Manager; the `DATABASE_URL` environment variable never contains the raw RDS writer endpoint.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; NFR-enforced decision |
