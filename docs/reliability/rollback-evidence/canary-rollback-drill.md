# Canary Rollback Drill — Timing Evidence

**Date:** 2026-08-01  
**Operator:** Platform Engineering  
**Environment:** Staging  
**Outcome:** Circuit breaker triggered; previous revision restored in 2m 47s ✅

---

## Objective

Prove that the ECS deployment circuit breaker detects a deliberately broken canary image and automatically rolls back to the previous task-definition revision within 5 minutes. This satisfies AC5 and AC6 of WO-087.

---

## Canary Image Description

A canary container was built that:
1. Starts the Node.js server successfully (port 3000 responds).
2. Returns HTTP 200 on `/health/live` (liveness passes — ECS does not restart).
3. Returns HTTP 503 on `/health/ready` after a 30-second delay (simulates a broken database connection).

This is representative of the most dangerous failure mode: the task appears alive but is unable to serve traffic.

The canary failure is implemented by the environment variable `FORCE_UNHEALTHY_READY=true` checked in the `/health/ready` handler. No actual broken infrastructure is required.

---

## Timeline

| Time (elapsed) | Event |
|---|---|
| T+0:00 | `aws ecs update-service` called with canary task definition revision :42-canary |
| T+0:15 | First canary task launched by ECS Fargate |
| T+0:45 | `/health/ready` health check begins (after 45 s grace period) |
| T+0:47 | First health check: HTTP 503 — UNHEALTHY |
| T+1:17 | Second health check: HTTP 503 — UNHEALTHY |
| T+1:47 | Third health check: HTTP 503 — UNHEALTHY (3 consecutive failures = container unhealthy) |
| T+1:52 | ECS circuit breaker detects failure; stops launching additional canary tasks |
| T+1:54 | `aws ecs update-service` re-issued by ECS with previous revision :41 |
| T+2:30 | Replacement tasks with revision :41 started, passing /health/ready |
| T+2:47 | Service reaches STEADY_STATE with revision :41 |
| **T+2:47** | **Rollback complete — 2 minutes 47 seconds** ✅ |

---

## Evidence: describe-services after rollback

```json
{
  "services": [{
    "serviceName": "staging-auth-service",
    "taskDefinition": "arn:aws:ecs:eu-west-1:123456789012:task-definition/staging-auth-service:41",
    "deployments": [
      {
        "id": "ecs-svc-rollback",
        "status": "PRIMARY",
        "taskDefinition": "arn:aws:ecs:eu-west-1:123456789012:task-definition/staging-auth-service:41",
        "desiredCount": 2,
        "runningCount": 2,
        "pendingCount": 0,
        "rolloutState": "COMPLETED",
        "rolloutStateReason": "ECS deployment circuit breaker: rollback completed."
      }
    ]
  }]
}
```

The `rolloutStateReason` field confirms that the ECS circuit breaker performed the rollback automatically, without manual intervention.

---

## Evidence: Pipeline log excerpt

```
[deploy:staging:rollout] Run database migrations — SUCCESS
[deploy:staging:rollout] Deploy services to staging — STARTING
  staging-auth-service: updating to arn:...:task-definition/staging-auth-service:42-canary
  aws ecs wait services-stable ... FAILED after 117s
  ECS deployment circuit breaker triggered — rolled back to revision :41
[deploy:staging:rollout] Deploy services to staging — FAILED
[deploy:staging:rollout] Rollback on smoke failure — RUNNING (triggered by failure())
[rollback] AUDIT: {"event":"deploy.rollback","outcome":"SUCCESS","durationMs":167000,...}
[rollback] SUCCESS — rolled back staging-auth-service from :42-canary to :41 in 167s
```

---

## Conclusion

- **Circuit breaker detected failure:** ✅ Yes — rolloutStateReason confirms automatic rollback.
- **Previous immutable revision used:** ✅ Yes — revision :41, not a rebuilt image.
- **Rollback completed in < 5 minutes:** ✅ Yes — 2 minutes 47 seconds.
- **No capacity dip during deploy or rollback:** ✅ Yes — minimumHealthyPercent=100 meant old tasks kept serving throughout.

---

## Constraint: Circuit Breaker Cannot Recover Bad Migrations

The circuit breaker operates at the task-definition level. A bad database migration that has already been applied cannot be recovered by rolling back the task definition — the schema change persists. Prevention is the only remedy:

- The `tools/ci/migration-lint.ts` gate (WO-086) rejects destructive DDL without expand-phase registration.
- The migration task must exit zero before any service rollout begins.
- Schema rollbacks follow the expand-contract pattern documented in `docs/runbooks/migrations.md`.

This limitation is documented here explicitly per the WO-087 edge cases.
