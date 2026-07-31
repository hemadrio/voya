# ecs-service module

Reusable Terraform module for a single Fargate ECS service. Produces a task
definition with an ADOT collector sidecar, per-service IAM roles, a CloudWatch
log group, optional load balancer registration, and ECS Service Connect.

## Service sizing (AC2)

| Service               | CPU units | Memory (MiB) | Port | Notes                              |
|-----------------------|-----------|--------------|------|------------------------------------|
| api-gateway           | 2048      | 4096         | 3000 | Fan-out proxy; JWT validation      |
| auth-service          | 512       | 1024         | 3001 | Stateless JWT; scales horizontally |
| user-service          | 512       | 1024         | 3002 | CRUD; low compute                  |
| flight-service        | 1024      | 2048         | 3003 | Search; Amadeus JSON parsing       |
| hotel-service         | 1024      | 2048         | 3004 | Search; same rationale as flight   |
| car-service           | 1024      | 2048         | 3005 | Search; same rationale as flight   |
| booking-service       | 1024      | 2048         | 3006 | Orchestrates traveler + payment    |
| payment-service       | 512       | 1024         | 3007 | Thin Stripe proxy; I/O bound       |
| ai-orchestration      | 2048      | 4096         | 3008 | Anthropic streaming; long-lived    |
| notification-consumer | 512       | 1024         | 3009 | SQS poller; no HTTP ingress        |

CPU units: 256 = 0.25 vCPU, 512 = 0.5 vCPU, 1024 = 1 vCPU, 2048 = 2 vCPU.
Memory in MiB. ADOT sidecar reserves an additional 256 CPU + 512 MiB.

## IAM boundaries

- **Task execution role** (`<env>-<service>-exec`): ECR pull, CloudWatch Logs,
  and `secretsmanager:GetSecretValue` scoped to the explicit ARNs in `secret_refs`.
  No wildcard resource. Adding a new secret requires a Terraform change for
  auditability.

- **Task role** (`<env>-<service>-task`): Application runtime permissions only.
  Telemetry (X-Ray, CloudWatch metrics) is always granted. SQS and RDS Proxy
  permissions are opt-in via `sqs_producer_queue_arns`, `sqs_consumer_queue_arns`,
  and `rds_connect_policy_arns`.

- Only `payment-service` receives Stripe secret ARNs.
- Only `flight/hotel/car-service` receive Amadeus/RapidAPI key ARNs.
- Only `ai-orchestration` receives the Anthropic key ARN.
- Only `notification-consumer` has `sqs_consumer_queue_arns`.
- `booking-service` and `payment-service` have `sqs_producer_queue_arns`.

## Credentials policy

Credentials **must not** appear in `environment_vars`. The module validation
rule rejects keys matching `SECRET|KEY|TOKEN|PASSWORD` at plan time. All
credentials are supplied via `secret_refs` (ECS secrets block → Secrets Manager
`valueFrom` ARNs).

## Service Connect

Set `enable_service_connect = true` and pass `service_connect_namespace_arn`
from the `ecs-cluster` module output. The ECS agent injects a proxy sidecar
that routes east-west traffic over mTLS.

Services resolve each other by the `service_connect_discovery_name` alias
(e.g. `http://booking-service:3006`). No DNS registration or Route 53 query
is required.

`notification-consumer` does not expose a Service Connect server port and sets
`enable_service_connect = false`.

## Health checks

- ALB target group: `/health/ready` — deep probe (DB, Redis, queue, secrets).
  Unhealthy tasks are never registered and receive no traffic.

- Container `healthCheck`: same `wget` call to `/health/ready` with
  `startPeriod = 45s` (covers Prisma client init + connection pool warm-up).
  Override via `health_check_start_period`.

## ADOT collector sidecar

Every task includes the ADOT sidecar (`essential = false`). It binds on
`127.0.0.1` to prevent external span injection. Traces go to X-Ray; metrics
go to CloudWatch EMF under the `travel/platform` namespace.
