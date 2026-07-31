# Runbook: Server-Side Validation Failure Spike

**Alarm:** `HIGH-validation-failure-spike`
**Severity:** HIGH
**SNS Topic:** platform-ticket

## Signal Meaning

Server-side validation failure spike: ≥ 100 `VALIDATION_FAILED` events in 5 minutes across booking, search, or user services.

Possible causes:
- **Contract mismatch**: a client update sends a schema that the server no longer accepts (or vice versa after a server-side breaking change).
- **Fuzz testing or security probing**: automated injection of malformed payloads.
- **Client bug**: a recently deployed client version with a schema regression.
- **Load test**: a load test hitting the validation layer without valid payloads.

## Diagnostic Steps

1. **Open the Platform Health Dashboard** → `{environment}-platform-health`. Check if the spike correlates with a deployment in any service (cross-reference ECS task revision changes).

2. **Run the Logs Insights query** across booking, search, and user service log groups:
   ```
   fields @timestamp, correlationId, service, path, field, event, @message
   | filter event = "VALIDATION_FAILED"
   | stats count(*) as failures by service, path, field
   | sort failures desc
   | limit 20
   ```
   The `field` value identifies which request field is failing validation. A single field on a single path indicates a schema regression; many fields across paths suggests fuzzing.

3. **Check client versions**: if the spike coincides with a mobile app release or a frontend deployment, examine the diff for schema changes in request construction. Cross-reference with `packages/contracts/` schema changes in recent commits.

## Expected Blast Radius

- Only requests with invalid payloads are rejected (400 responses). Valid requests are unaffected.
- If caused by a client regression, the affected client version may have a high failure rate for legitimate users.

## Escalation

- Confirmed client schema regression: coordinate with frontend/mobile team for rollback or fix.
- Confirmed fuzzing/probing: notify Security team and consider WAF rate-limit rule for the offending IP range.
