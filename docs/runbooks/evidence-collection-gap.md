# Runbook: HIGH-evidence-collection-gap

**Alarm:** `HIGH-evidence-collection-gap`
**Severity:** HIGH
**Namespace / Metric:** `travel/compliance` / `evidence_collector_heartbeat`

## Detection signal
CloudWatch alarm fires when `evidence_collector_heartbeat` count is `< 1` over a 25-hour window (treat_missing_data = breaching). This means the daily scheduled collector did not run or did not complete.

## Blast radius
- One or more controls in the SOC 2 traceability matrix have a gap in the observation window.
- The gap will appear in the monthly auditor report unless an artefact is backfilled.
- If the window contains multiple consecutive gaps, the observation window evidence may be insufficient for certification.

## Immediate containment
1. Check EventBridge scheduler: `aws scheduler get-schedule --name {env}-evidence-collector-daily`
2. Check ECS task history: `aws ecs list-tasks --cluster {cluster} --family {env}-evidence-collector --desired-status STOPPED`
3. Review CloudWatch Logs `/ecs/{env}/evidence-collector` for the last run attempt.
4. If the task exited with code 2: the control matrix has schema drift (adapter not registered). Fix and redeploy.
5. If the task exited with code 1: one or more source adapters failed. Review gap artefacts in S3 for the date.
6. If the task never started: EventBridge scheduler may be paused or the ECS cluster is unhealthy.
7. Manually trigger the collector if remediation is complete and the date is still current:
   `aws ecs run-task --cluster {cluster} --task-definition {task-def-arn} --launch-type FARGATE ...`

## Escalation path
1. On-call engineer: initial triage (0–30 min)
2. Platform lead: if multiple consecutive gaps (30+ min)
3. Compliance Lead: notification required if gap spans >24 hours

## Evidence to attach to the incident record
- EventBridge scheduler last invocation time and status
- ECS task stopped reason and exit code
- S3 manifest for the affected date (may be absent if the run never completed)
- CloudWatch Logs excerpt from the failed run
