# Runbook: [SHORT DESCRIPTIVE TITLE]

<!--
  MANDATORY FIELDS — do not ship a runbook without completing every section.
  The CI check-runbook-coverage.ts script validates that:
    1. Every alarm listed in **Alarms:** exists in the Terraform SLO module.
    2. Every alarm in the SLO module maps to at least one runbook in INDEX.md.
  Placeholder alarm names will fail the CI build.
-->

**Runbook ID:** RB-NNN
**Alarms:** `ALARM-NAME-ONE`, `ALARM-NAME-TWO`
**Severity:** CRITICAL | HIGH | INFO
**SNS Topic:** platform-page | platform-ticket | platform-info
**Owner:** Platform On-Call
**Last reviewed:** YYYY-QN

---

## 1. Severity and blast radius

**Severity:** [One sentence: what breaks and for whom]

**Blast radius:**
- [Service or customer journey affected]
- [Downstream impact: data integrity, revenue, SLA]
- [Rollback window: estimated time to recover if remediation step fails]

---

## 2. Detection signal

```
ALARM: <exact-cloudwatch-alarm-name>
Namespace: travel/<namespace>
Metric:    <metric_name>
Threshold: <exact threshold value and evaluation period>
```

**What the alarm means:** [One paragraph explaining the business significance of this alarm firing]

**Alarm correlation:** [Other alarms likely to fire alongside this one, and their causal relationship]

---

## 3. Triage — start from the reference identifier

Every API error envelope carries a `reference` field (trace ID). A traveler can
supply this from a screenshot. It resolves directly to the originating request.

**Step 1 — Resolve the reference to an X-Ray trace:**

```bash
# Replace <reference> with the value from the traveler-supplied screenshot
aws xray get-trace-summaries \
  --time-range-type TraceId \
  --filter-expression 'traceId = "<reference>"' \
  --query 'TraceSummaries[0].[Id, ResponseTime, Http.Status]' \
  --output table
```

**Step 2 — Filter correlated Pino log lines:**

```bash
# CloudWatch Logs Insights — substitute your log group and time range
aws logs start-query \
  --log-group-name "/ecs/${ENV}/<service-name>" \
  --start-time $(date -d '1 hour ago' +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, @message
    | filter correlationId = "<reference>"
    | sort @timestamp asc
    | limit 200'
```

**Step 3 — Check the CloudWatch dashboard:**
- Dashboard: `{environment}-[dashboard-name]`
- Widget: [exact widget title]

**Fallback (trace older than X-Ray retention window):**
- X-Ray trace retention is 30 days. For older references, query CloudWatch Logs
  Insights directly with the correlation ID filtered from the `reference` field.
- Log group: `/ecs/${ENV}/<service>` — filter `$.correlationId = "<reference>"`

---

## 4. Decision tree

```
Alarm fires
  └─ Is the alarm sustained or transient (< 5 min)?
       ├─ TRANSIENT → acknowledge, monitor for recurrence, no ticket required
       └─ SUSTAINED →
            ├─ Is the [primary indicator] elevated?
            │    ├─ YES → [proceed to Section 5 Step N]
            │    └─ NO  → [check [secondary indicator], proceed to Section 5 Step M]
            └─ Is [error type A] or [error type B] present in logs?
                 ├─ YES → [escalation path B — see Section 7]
                 └─ NO  → [standard remediation — see Section 5]
```

---

## 5. Remediation steps

> **Safety gate:** confirm you are targeting `${ENV}` (staging or production) before
> running any remediation command. Production changes require a second approval.

### Step 1 — [Action title]

```bash
# Command with environment variable placeholders — no hardcoded values
aws [service] [command] \
  --[flag] "${PARAMETER}" \
  --no-cli-pager
```

Expected output: [what a successful command output looks like]

### Step 2 — [Next action]

[Prose describing the step and its rationale]

```bash
# Command
```

### Step 3 — Verify the alarm cleared

```bash
aws cloudwatch describe-alarms \
  --alarm-names "ALARM-NAME-ONE" \
  --query 'MetricAlarms[0].StateValue' \
  --output text
```

Expected: `OK`

---

## 6. Verification (explicit success test)

Run each of the following after remediation. If any check fails, do NOT close the incident.

- [ ] `aws cloudwatch describe-alarms --alarm-names "ALARM-NAME-ONE" --query 'MetricAlarms[0].StateValue'` → `OK`
- [ ] [Service health endpoint] returns `200 { "status": "ok" }`
- [ ] [Metric] has returned to baseline range: [expected range]
- [ ] No new error events in CloudWatch Logs for 10 minutes after remediation

---

## 7. Rollback

If remediation makes the situation worse or introduces a new failure, roll back
to the previous immutable ECS task definition revision:

```bash
# 1. Identify the previous task definition revision
aws ecs describe-services \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-<service-name>" \
  --query 'services[0].{desired:desiredCount,running:runningCount,taskDef:taskDefinition}' \
  --output table

# 2. Roll back to the previous revision (replace :N with the prior revision number)
aws ecs update-service \
  --cluster "${ENV}-travel-platform" \
  --service "${ENV}-<service-name>" \
  --task-definition "${ENV}-<service-name>:<PREVIOUS_REVISION>" \
  --force-new-deployment

# 3. Wait for stabilisation (typically < 5 minutes for blue/green)
aws ecs wait services-stable \
  --cluster "${ENV}-travel-platform" \
  --services "${ENV}-<service-name>"
```

**Rollback target:** previous immutable task definition revision (n-1).
**Time to recover:** under 5 minutes via the previous task definition revision procedure.

---

## 8. Escalation contacts

| Trigger | Contact | Channel | SLA |
|---------|---------|---------|-----|
| Alarm sustained > 5 min | Platform On-Call | PagerDuty rotation | Immediate |
| Data integrity risk | Head of Engineering | `#incidents` Slack + direct page | 15 min |
| Revenue impact > £X | Finance / Head of Product | `#incidents` Slack | 30 min |
| Security signal | Security Lead | `#security-incidents` Slack + direct page | Immediate |

---

## 9. Post-incident evidence capture (SOC 2)

> Complete this section within 4 hours of alarm resolution. The incident ticket
> and linked artefacts form the SOC 2 audit evidence for this event.

1. **Capture the CloudWatch Logs Insights query result** for the alarm window and
   attach it to the incident ticket.

2. **Export the X-Ray trace** for the impacted reference IDs:
   ```bash
   aws xray batch-get-traces \
     --trace-ids "<trace-id-1>" "<trace-id-2>" \
     --output json > xray-traces-incident-<YYYYMMDD>.json
   ```

3. **Record in the incident ticket:**
   - Alarm first-fire timestamp
   - Root-cause classification (infra / code / config / supplier / operational)
   - Affected traveler count (if determinable from logs — count only, no PII)
   - Resolution timestamp and steps taken
   - Any configuration or code change required to prevent recurrence
   - Link to this runbook version (git commit SHA)

4. **Archive the evidence artefacts** to
   `s3://travel-platform-soc2-evidence/incidents/<YYYYMMDD>-<alarm-name>/`

5. **File a post-mortem** if customer impact lasted > 15 minutes or if a data
   integrity concern is not fully ruled out within 1 hour of resolution.
