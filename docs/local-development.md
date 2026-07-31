# Local Development Guide

## Bootstrap (one command)

The bootstrap script takes a clean checkout to a fully running local platform:

```bash
./scripts/bootstrap.sh
```

This performs these steps in order, each gated on the previous succeeding:

1. **Prerequisite checks** — container runtime reachable, Node v20.x, pnpm v9.x
2. **Environment file** — creates `.env` from `.env.example` if absent; diffs if present
3. **Install** — `pnpm install --frozen-lockfile` (a drifted lockfile fails with guidance)
4. **Infrastructure** — `docker compose up -d` + `wait-for-stack.sh` readiness gate
5. **Migrate** — applies pending Prisma migrations
6. **Seed** — loads the deterministic synthetic dataset
7. **Build** — compiles all workspace packages
8. **Develop** — fans out persistent watchers via `turbo run dev`

### Bootstrap flags

| Flag | Effect |
|------|--------|
| `--reset` | Drop Compose volumes and rebuild from scratch |
| `--skip-seed` | Skip the synthetic data seed step |
| `--infra-only` | Start the Compose stack only (no install, build, or dev) |

### Resume after partial failure

If bootstrap fails mid-way (e.g., database was not ready yet), re-run the same command — each step is idempotent. For a clean rebuild:

```bash
./scripts/bootstrap.sh --reset
```

---

## Quick start (manual)

If you prefer to run steps individually:

```bash
docker compose up -d
./scripts/wait-for-stack.sh    # blocks until all deps healthy (~60s cold start)
pnpm install --frozen-lockfile
pnpm build
pnpm db:seed
pnpm dev
```

Add the AWS emulation profile for SQS, SES, and Secrets Manager:

```bash
docker compose --profile aws up -d
./scripts/wait-for-stack.sh --aws
```

---

## Port map

### Infrastructure

| Service      | Host port | Protocol | Notes |
|--------------|-----------|----------|-------|
| PostgreSQL   | **5432**  | TCP/SQL  | `travel_dev` database |
| Redis        | **6379**  | TCP/RESP | `appendonly yes`, `allkeys-lru` eviction |
| RabbitMQ     | **5672**  | AMQP     | `travel.events` topology pre-declared |
| RabbitMQ UI  | **15672** | HTTP     | http://localhost:15672 (guest / guest) |
| LocalStack   | **4566**  | HTTP     | AWS edge — SQS, SES, Secrets Manager (profile: `aws`) |

### Application services

| Service                | Host port | Notes |
|------------------------|-----------|-------|
| api-gateway            | **3000**  | Single public entry point; JWT verification + rate limiting |
| auth-service           | **3001**  | Login, registration, Google OAuth, token rotation |
| user-service           | **3002**  | Traveler profiles and preferences |
| flight-service         | **3003**  | Amadeus GDS fan-out; Redis cache TTL 300s |
| hotel-service          | **3004**  | RapidAPI fan-out; Redis cache TTL 900s |
| car-service            | **3005**  | RapidAPI fan-out; Redis cache TTL 1800s |
| booking-service        | **3006**  | Saga orchestrator; SQS FIFO publisher |
| payment-service        | **3007**  | Stripe API + HMAC webhook verification |
| ai-orchestration       | **3008**  | Claude streaming; Redis conversation state |
| notification-consumer  | —         | SQS consumer — no HTTP port; no ingress |
| Frontend (Next.js)     | **3009**  | Next.js dev server |

---

## Environment variable reference

All variables are declared in `.env.example`. Copy that file to `.env` and replace placeholder values before starting services.

The startup validator (`@travel/config validateStartupEnv`) runs before any service binds its port. In `NODE_ENV=development` placeholder values emit a structured warning; in any other environment they cause a non-zero exit.

| Variable | Owner service(s) | Required | Placeholder OK in dev |
|----------|-----------------|----------|----------------------|
| `NODE_ENV` | all | yes | — |
| `LOG_LEVEL` | all | no (default: info) | — |
| `DATABASE_URL` | auth, booking, payment, user, itinerary, reporting, notification | yes | no |
| `REDIS_URL` | api-gateway, flight, hotel, car, booking, ai, notification | yes | no |
| `RABBITMQ_URL` | booking, notification | no | yes |
| `SQS_QUEUE_URL` | booking, notification-consumer | no (local), yes (staging/prod) | yes |
| `JWT_SECRET` | auth-service | yes | no |
| `JWT_PUBLIC_KEY` | api-gateway, user, booking, payment, ai, itinerary, reporting | yes | no |
| `GOOGLE_CLIENT_ID` | auth-service | no | yes |
| `GOOGLE_CLIENT_SECRET` | auth-service | no | yes |
| `STRIPE_SECRET_KEY` | payment-service | yes | no |
| `STRIPE_WEBHOOK_SECRET` | payment-service | yes | no |
| `AMADEUS_CLIENT_ID` | flight-service | no (local) | yes |
| `AMADEUS_CLIENT_SECRET` | flight-service | no (local) | yes |
| `RAPIDAPI_KEY` | hotel-service, car-service | no (local) | yes |
| `ANTHROPIC_API_KEY` | ai-service | yes | no |
| `SES_FROM_ADDRESS` | notification-consumer | yes | no |
| `NEXT_PUBLIC_API_BASE_URL` | frontend | yes | no |
| `SESSION_SECRET` | frontend | no | yes |
| `AWS_ENDPOINT_URL` | services using SQS/SES | no (local) | yes |

---

## Connection strings

Copy these into your `.env` or service environment:

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

### Drill 1 — Database failure

```bash
docker compose stop postgres
curl -s http://localhost:3000/health/ready | jq .
# Expected: { "status": "unhealthy", "checks": { "database": "unhealthy", "cache": "healthy", "queue": "healthy" } }

docker compose start postgres
./scripts/wait-for-stack.sh
# Expected: [OK] travel-postgres is healthy
```

### Drill 2 — Cache (Redis) failure

```bash
docker compose stop redis
curl -s http://localhost:3000/health/ready | jq .
# Expected: { "status": "degraded", "checks": { "database": "healthy", "cache": "unhealthy", "queue": "healthy" } }
# Services degrade to direct supplier calls; no error page.

docker compose start redis
./scripts/wait-for-stack.sh
```

### Drill 3 — Queue failure

```bash
docker compose stop rabbitmq
curl -s http://localhost:3000/health/ready | jq .
# Expected: { "status": "degraded", "checks": { "database": "healthy", "cache": "healthy", "queue": "unhealthy" } }
# Bookings can still be created; notifications will not be sent until restored.

docker compose start rabbitmq
./scripts/wait-for-stack.sh
```

Each dependency container can be stopped and restarted independently because all services are on the same named bridge network (`travel-local`) and connect by DNS name.

---

## Reset and teardown commands

| Command | Effect |
|---------|--------|
| `./scripts/bootstrap.sh --reset` | Drop all volumes, re-create containers, re-migrate, re-seed |
| `docker compose down -v` | Stop all containers and delete named volumes |
| `docker compose down` | Stop containers, keep volumes (state preserved) |
| `docker compose up -d` | Start containers (reuse existing volumes) |
| `pnpm db:reset` | Drop schema, re-apply migrations, re-seed (no container restart) |
| `./scripts/wait-for-stack.sh` | Block until all containers are healthy |

---

## Persistence

State persists across `compose down` (without `-v`) because each service uses a named volume:

| Volume | Service | Path in container |
|--------|---------|-------------------|
| `postgres_data` | PostgreSQL | `/var/lib/postgresql/data` |
| `redis_data` | Redis | `/data` (appendonly AOF) |
| `rabbitmq_data` | RabbitMQ | `/var/lib/rabbitmq/mnesia` |
| `localstack_data` | LocalStack | `/var/lib/localstack` |

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

---

## AWS emulation (LocalStack)

Start with `docker compose --profile aws up -d`. The init scripts in `infra/local/localstack/init/` run automatically after LocalStack is ready and create:

- SQS FIFO queues: `travel-notification.fifo`, `travel-booking.fifo`, `travel-payment.fifo` (plus DLQ variants)
- Secrets Manager entries with `dev/travel-platform/` prefix and development-only placeholder values

```bash
docker exec travel-localstack awslocal sqs list-queues --region eu-west-1
docker exec travel-localstack awslocal secretsmanager list-secrets --region eu-west-1 --query 'SecretList[].Name'
```

---

## Synthetic seed data

The platform uses a deterministic synthetic seed that produces a reproducible graph of users, itineraries, bookings, payments, events, and audit rows. All values use the `@synth.example` email domain and `SYNTH-` identifier prefixes — they are never real data.

```bash
pnpm db:seed    # idempotent — upserts to the same state on re-run
```

| Persona | ID prefix | Notes |
|---------|-----------|-------|
| Alice Leisure | `f0000000-…-0001` | Multi-category itinerary (flight + hotel + car) |
| Bob Business | `f0000000-…-0002` | Saved travel preferences, business seat class |
| Charlie Guest | `f0000000-…-0003` | Guest-originated itinerary, erasure request pending |

---

## CI integration

The CI smoke-test job boots the stack, waits for readiness, and runs protocol probes:

```yaml
- name: Start local stack
  run: docker compose up -d

- name: Wait for stack
  run: ./scripts/wait-for-stack.sh
  timeout-minutes: 2

- name: Run integration tests
  run: pnpm test:integration
```

The `wait-for-stack.sh` script exits non-zero with per-container diagnostics if any dependency does not become healthy within 120 seconds.

---

## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| `Port 5432 already in use` | Another Postgres instance running (local or other container) | `lsof -i :5432` to find the process; stop it or use a different `PGPORT` |
| `Permission denied to read PostgreSQL data volume` | Volume owned by root from a previous Docker version | `docker compose down -v` to drop the volume; restart |
| PostgreSQL `data directory has wrong ownership` | Volume was initialised by a different major version | `docker compose down -v postgres` then `docker compose up -d postgres` |
| `pnpm install --frozen-lockfile` fails with `ERR_PNPM_OUTDATED_LOCKFILE` | A `package.json` was changed without running `pnpm install` | Run `pnpm install` in a branch, commit the updated `pnpm-lock.yaml` |
| `Container runtime not running` | Docker Desktop is not started, or the daemon is stopped | Start Docker Desktop, or `sudo systemctl start docker` on Linux |
| Architecture or platform mismatch (`exec format error`) | Pulled a linux/amd64 image on Apple Silicon | Add `platform: linux/arm64/v8` or `linux/amd64` to the service in `docker-compose.yml`, or run `docker compose pull` to re-pull |
| Service exits with `[env] Required environment variable is invalid: STRIPE_SECRET_KEY` | `.env` is missing a required variable or still holds a placeholder | Open `.env`, locate `STRIPE_SECRET_KEY`, and replace the placeholder; see `.env.example` for the expected format |
| Service exits with `[env] Placeholder value detected in non-development environment` | `NODE_ENV` is set to `staging` or `production` while `.env` still has a placeholder value | Either set `NODE_ENV=development` for local work, or replace the placeholder with a real value |
| `wait-for-stack.sh` timeout — `travel-postgres` never becomes healthy | Container started but `max_connections` pool full, or init SQL failed | `docker compose logs postgres` to read init errors; `docker compose down -v postgres && docker compose up -d postgres` to reinitialise |
| Bootstrap fails with `Another bootstrap invocation is already running` | A previous `bootstrap.sh` is still running (or crashed, leaving a stale lock) | Wait for the first run to complete, or `rm /tmp/travel-platform-bootstrap.lock` to release the stale lock |
| `docker compose` reports stale volumes from an older database major | PostgreSQL data dir was written by v15, image is now v16 | `docker compose down -v` removes all named volumes; restart boots a fresh cluster on the new major |

---

## Log tailing

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f postgres
docker compose logs -f redis

# Service application logs (if running locally)
pnpm --filter auth-service dev 2>&1 | pino-pretty
```
