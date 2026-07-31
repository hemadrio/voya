# Runbook: CRITICAL-illustrative-result-exposure

**Alarm:** `CRITICAL-illustrative-result-exposure`
**Severity:** CRITICAL
**Namespace / Metric:** `travel/security` / `illustrative_result_exposures_total`

## Detection signal
CloudWatch alarm fires when `illustrative_result_exposures_total > 0` in any 5-minute window. The target is exactly zero unflagged exposures in production.

## Blast radius
- A non-bookable (illustrative) search result was presented to a user without the required audit-logged feature flag.
- Users may have seen prices or availability that cannot be fulfilled, violating the platform integrity guarantee.
- SOC 2 CC7 (System Operations) and the booking integrity constraint (BR-05) are affected.

## Immediate containment
1. Identify the source: check `travel/security` CloudWatch Logs for `event=illustrative_result_exposure`.
2. Determine the supplier adapter or feature flag that allowed the exposure.
3. If caused by a missing `provenance` tag: the normalisation layer has a bug — roll back the affected service version.
4. If caused by an unapproved feature flag: disable the flag immediately via the feature flag service.
5. Assess whether any users proceeded to checkout with an illustrative result (the booking service should reject these at `PENDING` creation — verify).

## Escalation path
1. On-call engineer: immediate triage
2. Engineering lead: root-cause investigation within 30 min
3. Product: user communication if any users were affected
4. Compliance Lead: notify regardless of user impact

## Evidence to attach to the incident record
- Log events with `event=illustrative_result_exposure` from the alarm window
- Deployment history for the affected service (to identify the responsible commit)
- Feature flag audit log for any flags enabled at the time
- Booking service rejection logs confirming no bookings completed with the illustrative result
