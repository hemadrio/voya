# Deploy and Rollback Runbook

**Owner:** Platform Engineering  
**Review cycle:** Quarterly  
**SLO:** Rollback to previous revision completes within 5 minutes of decision.

---

## Overview

The travel platform uses ECS rolling deployments with a circuit-breaker that automatically reverts to the previous immutable task-definition revision when health checks fail during a rollout. Manual rollback is available via `tools/ci/rollback.ts` when automated recovery is insufficient or when a post-deploy regression is detected after the circuit breaker window.

**Key constraints (must never be violated):**
- Capacity must never dip below `minimumHealthyPercent = 100` during a rollout.
- Rollback must always target a previous immutable task-definition revision. Rebuilding an image to roll back is not acceptable.
- Production promotion requires approval by someone other than the commit author (A03 separation of duty).

---

## ECS Service Configuration Evidence

The following Terraform configuration is committed at `infra/terraform/modules/ecs-service/task-definition.tf`:

```hcl
resource "aws_ecs_service" "service" {
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
```

And in `variables.tf`:
```hcl
variable "health_check_path" {
  default = "/health/ready"
}
```

The `/health/ready` endpoint performs a deep dependency check (database, cache, queue, secrets). A task with any unavailable dependency fails readiness and never receives traffic. This prevents the circuit breaker false-negative where a task is healthy at the TCP level but broken at the application level.

---

## Normal Deploy Flow

```
push to main (or v* tag)
  → source checkout
  → build:node (typecheck, test, coverage gate)
  → build:docker (cosign-signed distroless images)
  → push:registry
  → gate:smoke:staging
  → deploy:dev    (automatic)
  → deploy:staging (automatic, post-smoke)
    ↓ if smoke fails → auto-rollback staging
  → deploy:production (manual approval, v* tags only)
    → approval-check (separation of duty)
    → cosign verify
    → migration task exits zero
    → ECS rolling update (circuit breaker armed)
    → post-deploy smoke
    ↓ if smoke fails → manual rollback via rollback.ts
```

**Pull-request builds never deploy.** The `deploy:dev`, `deploy:staging`, and `deploy:production` stage groups all have `when.event.not_in: [pull_request]`.

---

## Automatic Circuit-Breaker Rollback

ECS monitors the health of newly launched tasks during a rolling deploy. If the number of tasks in the `RUNNING` state with the new task definition fails to reach the desired count within the circuit-breaker evaluation window, ECS:

1. Stops launching new tasks with the failing task definition.
2. Re-points the service `taskDefinition` at the previous immutable revision.
3. Waits for the fleet to reach steady state with the old revision.

**Duration:** Typically 2–4 minutes (cold-start + health-check grace period + two passing health checks).

**Evidence requirement (AC5):** A deliberately failing canary deploy to staging demonstrates this flow. See `docs/reliability/rollback-evidence/canary-rollback-drill.md`.

---

## Manual Rollback

Use `tools/ci/rollback.ts` when:
- The circuit breaker did not fire (e.g., the failure manifests after the grace period).
- A post-deploy smoke test regression is detected.
- An on-call escalation requires immediate manual intervention.

### Prerequisites

- AWS credentials with `ecs:DescribeServices`, `ecs:UpdateService`, `ecs:DescribeTasks` on the target cluster.
- The `FORGE_ACTOR` environment variable is set by the Forge runner; set it manually when running outside CI: `export FORGE_ACTOR=$(aws sts get-caller-identity --query Arn --output text)`

### Execute rollback

```bash
# Single service
tsx tools/ci/rollback.ts \
  --cluster production-travel-platform \
  --service production-auth-service \
  --region eu-west-1

# All services (pipeline uses this pattern)
for service_dir in services/*/; do
  service=$(basename "$service_dir")
  tsx tools/ci/rollback.ts \
    --cluster production-travel-platform \
    --service "production-${service}" \
    --region eu-west-1
done
```

### Expected output

```
[rollback] Starting rollback: cluster=production-travel-platform service=production-auth-service actor=arn:aws:sts::123:assumed-role/...
[rollback] AUDIT: {"event":"deploy.rollback","actor":"...","timestamp":"...","cluster":"...","service":"...","previousRevision":"...","newRevision":"...","durationMs":180000,"outcome":"SUCCESS"}
[rollback] SUCCESS — rolled back production-auth-service from arn:...:42 to arn:...:41 in 180s
```

### First-deploy edge case

If the service has only one deployment in its history (first deploy), the script exits 1 with:

```
[rollback] FAILED (NO_PREVIOUS_REVISION): Service "production-auth-service" has no previous task-definition revision...
```

In this case, identify the correct task-definition revision manually:
```bash
aws ecs list-task-definitions --family-prefix production-auth-service --sort DESC --region eu-west-1
```

---

## Production Approval Gate

Production promotion requires a manual approval by someone other than the commit author. `tools/ci/approval-check.ts` reads the approver identity from `FORGE_APPROVER` (injected by the Forge runner's authenticated SSO session — cannot be overridden by the pipeline YAML) and the commit author from git log.

**Rejected self-approval example:**
```
[approval-check] AUDIT: {"event":"deploy.approval_check","timestamp":"...","approver":"alice@...","commitAuthor":"alice@...","passed":false,"reason":"Self-approval rejected..."}
[approval-check] REJECTED (SELF_APPROVAL): Self-approval rejected: approver "alice@..." is the same as commit author "alice@..."
```

This rejection and its audit record satisfy SOC 2 change-management evidence for A03 separation of duty.

---

## Rollback SLO: Under 5 Minutes

**Target:** Decision to full previous-revision steady state ≤ 5 minutes.

**Measurement:** `tools/ci/rollback.ts` outputs `durationMs` in the audit record and warns if the rollback exceeds 5 minutes.

**Timing drill evidence:** See `docs/reliability/rollback-evidence/`.

**Factors that affect rollback duration:**
| Factor | Impact | Mitigation |
|---|---|---|
| `health_check_start_period` | Adds to each task's startup time | Keep ≤ 45 s unless Prisma init is slow |
| `desired_count` | More tasks = more parallel health checks | Fargate parallelism is good |
| ALB deregistration delay | Drains connections before the task stops | Default 30 s; reduce to 15 s for stateless services |
| AWS API throttling | Slows `UpdateService` response | Retry with backoff; already handled by `aws ecs wait` |

---

## Canary Rollback Drill (AC5, AC6)

See `docs/reliability/rollback-evidence/canary-rollback-drill.md` for the full procedure and timing evidence from a deliberate failure exercise.

**Summary of drill procedure:**
1. Build a canary container that fails `/health/ready` after 30 seconds (simulating a broken dependency).
2. Deploy to staging via the normal pipeline.
3. Observe ECS circuit breaker detecting the failure and reverting to the previous revision.
4. Record time from first failed health check to steady state with old revision.
5. Confirm < 5 minutes.

---

## Migration Failure Blocks Rollout (AC8)

The migration task runs before any service rollout. A non-zero exit from the migration ECS task causes the deploy step to fail without touching the service task definition. This prevents a bad schema change from being rolled back at the application layer — schema rollbacks require an expand-contract migration (see `docs/runbooks/migrations.md`).

**Documented limitation:** The circuit breaker cannot recover from a bad migration that has already been applied. The migration must be fixed and re-applied via the expand-contract path. This is by design — see `docs/runbooks/migrations.md`.

---

## Audit Log

Every deploy and rollback action emits a structured audit record to stdout prefixed with `[rollback] AUDIT:` or `[approval-check] AUDIT:`. The Forge runner captures all stdout and ships it to the immutable audit log sink (`FORGE_AUDIT_SINK`).

**Record schema:**
```typescript
interface DeployRollbackAuditRecord {
  event: "deploy.rollback";
  actor: string;       // Identity performing the rollback
  timestamp: string;   // ISO 8601
  cluster: string;
  service: string;
  previousRevision: string;   // ARN of revision being rolled back FROM
  newRevision: string;        // ARN of revision being rolled back TO
  durationMs: number;
  outcome: "SUCCESS" | "FAILURE";
  errorMessage?: string;
}
```
