# Secret Rotation Runbook

This runbook covers normal rotation, rotation failure recovery, and the JWT
two-phase rotation procedure. See `secret-inventory.md` for the full list of
secrets, owning services, and rotation owners.

---

## 1. Normal Automated Rotation

Secrets with `rotatable: true` in the Terraform secrets module have an
`aws_secretsmanager_secret_rotation` resource configured with a 90-day
schedule. AWS triggers the rotation Lambda automatically.

**To verify rotation succeeded:**

```bash
aws secretsmanager describe-secret \
  --secret-id staging/travel-platform/<slug> \
  --query 'RotationEnabled,LastRotatedDate,NextRotationDate'
```

Expected output: `RotationEnabled: true`, `LastRotatedDate` within the last 90
days.

---

## 2. Rotation Failure Recovery

When the rotation Lambda fails:

1. **AWS Secrets Manager leaves the current version active.** No service loses
   access; the previous value remains in `AWSCURRENT`.
2. A CloudWatch alarm (`SecretRotationFailed`) fires and pages the on-call
   engineer.
3. Investigate the Lambda execution logs:
   ```bash
   aws logs tail /aws/lambda/secrets-rotation-lambda --since 2h
   ```
4. Fix the underlying issue (e.g. RDS connectivity, IAM permission).
5. Manually trigger rotation to restart the rotation cycle:
   ```bash
   aws secretsmanager rotate-secret \
     --secret-id staging/travel-platform/<slug>
   ```
6. Confirm success with `describe-secret` (see above).

---

## 3. JWT Signing Key Two-Phase Rotation

The JWT signing key uses a two-phase rotation to avoid a 401 storm for
logged-in users:

### Phase 1 — Promote new key

1. Generate a new RSA-2048 key pair:
   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out new-private.pem
   openssl rsa -pubout -in new-private.pem -out new-public.pem
   ```
2. Compose the new key material JSON:
   ```json
   {
     "privateKeyPem": "<content of new-private.pem>",
     "publicKeyPem": "<content of new-public.pem>",
     "activatedAt": "<current ISO-8601 timestamp>",
     "version": "<v{N+1}>"
   }
   ```
   **Never commit this JSON to the repository.** Inject it directly:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id staging/travel-platform/jwt-signing-key \
     --secret-string "$(cat key-material.json)" \
     --version-stages AWSCURRENT
   ```
3. Verify the previous value was promoted to `AWSPREVIOUS`:
   ```bash
   aws secretsmanager describe-secret \
     --secret-id staging/travel-platform/jwt-signing-key \
     --query 'VersionIdsToStages'
   ```
4. Delete the local key files immediately:
   ```bash
   shred -u new-private.pem new-public.pem key-material.json
   ```

### Phase 2 — Drop previous key (after 24-hour overlap)

Wait at least 24 hours after Phase 1 to ensure all tokens issued with the old
key have expired (15-minute access token TTL + 24-hour overlap margin).

After 24 hours, the `KeyProvider` will automatically stop including the
previous key in `getVerificationKeys()` because its `activatedAt` timestamp
falls outside the `overlapMs` window.

No service restart is required. Services pick up the refreshed key set on the
next cache TTL expiry (default: 60 seconds).

To explicitly remove the `AWSPREVIOUS` stage:
```bash
aws secretsmanager update-secret-version-stage \
  --secret-id staging/travel-platform/jwt-signing-key \
  --version-stage AWSPREVIOUS \
  --remove-from-version-id <old-version-id>
```

### Rotation rehearsal verification

After Phase 1, issue a test token using the previous key (if you have a
staging token from before the rotation), replay it against the API, and
confirm HTTP 200. After Phase 2, confirm the same token returns HTTP 401
with `code: TOKEN_INVALID`.

---

## 4. Manual Secret Bootstrap

New secrets are bootstrapped out-of-band — never via `terraform apply`. After
the Terraform resource is created (which creates an empty secret shell):

```bash
aws secretsmanager put-secret-value \
  --secret-id staging/travel-platform/<slug> \
  --secret-string '<value>'
```

Terraform's `lifecycle { ignore_changes = [secret_string] }` ensures
subsequent applies do not overwrite the bootstrapped value.

---

## 5. Emergency Secret Revocation

If a secret is suspected compromised:

1. Immediately generate a new value and update the secret (see bootstrap above).
2. Notify the on-call security engineer.
3. Review CloudTrail for `GetSecretValue` calls from unexpected principals:
   ```bash
   aws cloudtrail lookup-events \
     --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
     --start-time $(date -d '24 hours ago' -u +%Y-%m-%dT%H:%M:%SZ)
   ```
4. If the compromised secret was the JWT signing key, perform an emergency
   two-phase rotation (Phase 1 immediately, Phase 2 after existing tokens expire
   — at most 15 minutes for access tokens).
5. Record the incident in the Forge audit log and create a post-mortem.

---

## 6. Adding a New Secret

1. Add the slug and metadata to `infra/terraform/modules/secrets/main.tf`
   under `locals.secrets`.
2. Add the slug to the appropriate service's list in
   `infra/terraform/envs/staging/main.tf` and
   `infra/terraform/envs/production/main.tf` under `service_secret_map`.
3. Apply Terraform to create the secret shell (no value yet).
4. Bootstrap the secret value out-of-band (see section 4).
5. Update `docs/security/secret-inventory.md`.

If the service list for a service is not declared in `service_secret_map`,
Terraform will fail the plan — this is intentional (fail-safe for omitted
secrets).
