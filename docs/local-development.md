# Local Development Guide

## Quick start

```bash
docker compose up -d
./scripts/wait-for-stack.sh    # blocks until all deps healthy (~60s cold start)
```

Add the AWS emulation profile for SQS, SES, and Secrets Manager:

```bash
docker compose --profile aws up -d
./scripts/wait-for-stack.sh --aws
```

---

## Port map

| Service      | Host port | Protocol | Notes |
|--------------|-----------|----------|-------|
| PostgreSQL   | **5432**  | TCP/SQL  | `travel_dev` database |
| Redis        | **6379**  | TCP/RESP | `appendonly yes`, `allkeys-lru` eviction |
| RabbitMQ     | **5672**  | AMQP     | `travel.events` topology pre-declared |
| RabbitMQ UI  | **15672** | HTTP     | http://localhost:15672 (guest / guest) |
| LocalStack   | **4566**  | HTTP     | AWS edge — SQS, SES, Secrets Manager (profile: `aws`) |

These ports are reserved for the local stack. Nine application services use ports 3000–3008.

---

## Connection strings

Copy these into your `.env.local` or service environment:

```dotenv
# PostgreSQL — always include connection_limit=5 to match RDS Proxy ceiling
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable

# Redis
REDIS_URL=redis://localhost:6379

# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@localhost:5672/
QUEUE_DRIVER=rabbitmq

# AWS (profile: aws only)
AWS_ENDPOINT_URL=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_DEFAULT_REGION=eu-west-1
```

Use `packages/config buildLocalDatabaseUrl()` to construct `DATABASE_URL` in code — never hand-edit the connection string per service.

---

## PostgreSQL connection budget

Production uses RDS Proxy with `connection_limit=5` enforced by `@travel/config assertConnectionLimit()`. The local stack mirrors this:

| Consumers | Count | Connections |
|-----------|-------|-------------|
| Services (9 × 5) | 9 | 45 |
| Migration task | 1 | 10 |
| Dev tooling (psql, pgAdmin, integration tests) | — | 45 |
| **Total** | | **100** |

`max_connections=100` is set via the `postgres` command flag in `docker-compose.yml`. Do not raise it without updating this table and `infra/terraform/modules/rds-proxy/connection-budget.md`.

---

## Dependency-failure drills

The deep readiness probe on the API gateway checks all four dependency classes. Use these commands to verify each class can be isolated:

```bash
# Drill 1 — database failure
docker compose stop postgres
# Expect: /healthz reports database=unhealthy, cache=healthy, queue=healthy

# Drill 2 — cache failure
docker compose stop redis
# Expect: /healthz reports database=healthy, cache=unhealthy, queue=healthy

# Drill 3 — queue failure
docker compose stop rabbitmq
# Expect: /healthz reports database=healthy, cache=healthy, queue=unhealthy

# Restore
docker compose up -d postgres redis rabbitmq
./scripts/wait-for-stack.sh
```

Each dependency container can be stopped and restarted independently because all services are on the same named bridge network (`travel-local`) and connect by DNS name.

---

## Persistence

State persists across `compose down` (without `-v`) because each service uses a named volume:

| Volume | Service | Path in container |
|--------|---------|-------------------|
| `postgres_data` | PostgreSQL | `/var/lib/postgresql/data` |
| `redis_data` | Redis | `/data` (appendonly AOF) |
| `rabbitmq_data` | RabbitMQ | `/var/lib/rabbitmq/mnesia` |
| `localstack_data` | LocalStack | `/var/lib/localstack` |

**Reset command (clean slate):**

```bash
docker compose down -v   # removes containers AND all named volumes
docker compose up -d
```

> **Warning:** If you upgrade PostgreSQL to a new major version (e.g., 16 → 17), the old data volume is incompatible. Run `docker compose down -v` before upgrading the image tag.

---

## RabbitMQ topology

The local RabbitMQ pre-declares the topology used by the `@travel/queue` RabbitMqAdapter at startup (via `infra/local/rabbitmq/definitions.json`):

| Resource | Type | Notes |
|----------|------|-------|
| `travel.events` | Topic exchange | Main event bus |
| `travel.events.dlq` | Topic exchange | Dead-letter exchange |
| `travel.notification` | Durable queue | Bound to `travel.events` / routing key `notification` |
| `travel.booking` | Durable queue | Bound to `travel.events` / routing key `booking` |
| `travel.payment` | Durable queue | Bound to `travel.events` / routing key `payment` |
| `travel.notification.dlq` | Durable queue | DLQ for notification |
| `travel.booking.dlq` | Durable queue | DLQ for booking |
| `travel.payment.dlq` | Durable queue | DLQ for payment |

If you rename a queue in the adapter, update `infra/local/rabbitmq/definitions.json` and restart RabbitMQ.

---

## AWS emulation (LocalStack)

Start with `docker compose --profile aws up -d`. The init scripts in `infra/local/localstack/init/` run automatically after LocalStack is ready and create:

- SQS FIFO queues: `travel-notification.fifo`, `travel-booking.fifo`, `travel-payment.fifo` (plus DLQ variants)
- Secrets Manager entries with `dev/travel-platform/` prefix and development-only placeholder values

Inspect queues and secrets:

```bash
# List queues
docker exec travel-localstack awslocal sqs list-queues --region eu-west-1

# List secrets
docker exec travel-localstack awslocal secretsmanager list-secrets --region eu-west-1 --query 'SecretList[].Name'
```

---

## CI integration

The CI smoke-test job boots the stack, waits for readiness, and runs protocol probes:

```yaml
# .github/workflows/ci.yml (excerpt)
- name: Start local stack
  run: docker compose up -d

- name: Wait for stack
  run: ./scripts/wait-for-stack.sh
  timeout-minutes: 2

- name: Run integration tests
  run: pnpm test:integration
```

The `wait-for-stack.sh` script exits non-zero with per-container diagnostics if any dependency does not become healthy within 120 seconds, which fails the pipeline immediately rather than letting tests silently time out.

---

## Troubleshooting

**Port already in use:**
```bash
lsof -i :5432   # find the conflicting process
```

**PostgreSQL volume from a different major version:**
```bash
docker compose down -v    # destroy old volume
docker compose up -d postgres
```

**RabbitMQ queue missing:**
The definitions file is loaded on first start. If you edited it after initial start, delete the volume and restart:
```bash
docker compose down -v rabbitmq
docker compose up -d rabbitmq
./scripts/wait-for-stack.sh
```

**Check container health:**
```bash
docker compose ps              # shows health status
docker inspect travel-postgres | jq '.[].State.Health'
```
