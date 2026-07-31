# Runbook: Authentication Failure Spike

**Alarm:** `HIGH-auth-failure-spike`
**Severity:** HIGH
**SNS Topic:** platform-ticket

## Signal Meaning

Authentication failure spike: ≥ 20 `AUTH_FAILED` events in 5 minutes from the user-service.

Possible causes:
- **Credential stuffing**: automated attacks cycling through a leaked credential list.
- **Brute-force login**: repeated failed attempts against a small set of accounts.
- **Configuration error**: auth service misconfiguration causing legitimate logins to fail.
- **Client bug**: a specific app version sending malformed credentials.

## Diagnostic Steps

1. **Open the Platform Health Dashboard** → `{environment}-platform-health`, Security Events widget. Correlate the auth failure spike with any simultaneous access-denied spike (might indicate the attacker progressed past authentication on some accounts).

2. **Run the Logs Insights query** against `/ecs/{environment}/user-service`:
   ```
   fields @timestamp, correlationId, email, ipAddress, userAgent, event, @message
   | filter event = "AUTH_FAILED"
   | stats count(*) as attempts by ipAddress, userAgent
   | sort attempts desc
   | limit 20
   ```
   A single IP with many attempts → targeted brute-force. Many IPs with few attempts each → credential stuffing.

3. **Check for concurrent successful authentications** from the same IPs:
   ```
   fields @timestamp, correlationId, ipAddress, event
   | filter event = "AUTH_SUCCEEDED" or event = "AUTH_FAILED"
   | stats count(*) as count by event, ipAddress
   | sort count desc
   ```
   A high failure rate followed by a success from the same IP suggests account takeover.

## Expected Blast Radius

- Account takeover risk if attacks are partially successful.
- Legitimate users may be locked out if account lockout policy triggers.

## Escalation

- Confirmed credential stuffing at scale: engage Security team and consider temporary rate-limiting at the WAF level.
- Evidence of successful account takeover: escalate to Security Incident Response immediately.
- If cause is a client bug: coordinate with mobile/frontend team for an emergency patch.
