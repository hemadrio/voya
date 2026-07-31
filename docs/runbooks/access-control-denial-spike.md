# Runbook: HIGH-access-control-denial-spike

**Alarm:** `HIGH-access-control-denial-spike`
**Severity:** HIGH
**Namespace / Metric:** `travel/security` / `access_control_denials_total`

## Detection signal
CloudWatch alarm fires when `access_control_denials_total ≥ 50` in any 5-minute window.

## Blast radius
- Possible credential-stuffing, brute-force, or horizontal privilege escalation attempt.
- Legitimate users may be locked out if a configuration error is the cause.

## Immediate containment
1. Check gateway logs for the source IP distribution of 403 responses: `{ $.status = 403 }`.
2. If a single IP accounts for >50% of denials: add a WAF rate rule for that IP immediately.
3. If denials are spread across many IPs with the same user-agent: possible bot sweep; enable aggressive WAF mode.
4. If denials are from legitimate users: check for a recent role-mapping or JWT config change.
5. Verify the `requireRole` middleware is returning the correct roles from the token.
6. Check for a recent deployment of auth-service or api-gateway that may have changed role extraction.

## Escalation path
1. On-call engineer: triage and WAF mitigation (0–15 min)
2. Security Lead: if attack pattern is confirmed (15–30 min)
3. Head of Engineering: if legitimate users are being locked out

## Evidence to attach to the incident record
- CloudWatch Logs with 403 response distribution (IP, user-agent, route)
- WAF rule actions taken and timestamps
- Deployment history for auth-service and api-gateway for the preceding 24 hours
