# Phase 0 Gate Evidence — WO-085

This directory holds the evidence that the three mandatory red-build scenarios
each block the pipeline with an actionable message and no secret leakage.

## Red-Build Scenarios

### Scenario 1 — Vulnerable dependency (Snyk blocks)

**Fixture**: A synthetic `package.json` that adds `lodash@4.17.19` (known
prototype-pollution CVE-2020-8203) to the workspace root devDependencies.

**Expected pipeline outcome**: `scan:snyk` exits 1 with:
```
✗ High severity vulnerability found in lodash
  Description: Prototype Pollution
  Info: https://snyk.io/vuln/SNYK-JS-LODASH-567746
  Introduced through: lodash@4.17.19
```
No repository secrets appear in the output.

**Evidence file**: `scenario1-snyk-block.txt` — captured pipeline log excerpt.

---

### Scenario 2 — Committed artefact + .env (artifact-guard blocks)

**Fixture**: A branch adding:
- `dist/my-service-1.0.0.tgz` (synthetic packaged npm artefact)
- `.env.production` (synthetic environment file with placeholder values only —
  no real credentials)

**Expected pipeline outcome**: `scan:artifact-guard` exits 1 with:
```
[artifact-guard] FAIL — prohibited files detected in commit diff:

  ✗  dist/my-service-1.0.0.tgz
     Packaged npm artefact (.tgz). Run `npm pack` locally and add to .gitignore.

  ✗  .env.production
     Environment file (.env / .env.*). Use a secrets manager or CI secrets; never commit credentials.

2 violation(s) found.
```

**Evidence file**: `scenario2-artifact-guard-block.txt`

---

### Scenario 3 — Reintroduced placeholder secret (Gitleaks blocks)

**Fixture**: A branch adding a comment in `services/api-gateway/src/config.ts`:
```typescript
// JWT_SIGNING_SECRET=super-secret-jwt-key-placeholder-32chars
```
Using a placeholder value matching the `jwt-signing-secret-placeholder` rule.

**Expected pipeline outcome**: `scan:gitleaks` exits 1 with:
```
○  jwt-signing-secret-placeholder
    Secret:   [REDACTED]
    File:     services/api-gateway/src/config.ts
    Line:     <n>
    Commit:   <sha>
```
The secret VALUE is redacted in the output (Gitleaks `--redact` flag is
required in the pipeline invocation).

**Evidence file**: `scenario3-gitleaks-block.txt`

---

## Verification of Parallelism

Pipeline run timing for a representative build shows all five scanners
running concurrently:

```
scan:sonarqube  [00:00 → 01:42]
scan:snyk       [00:00 → 00:53]  ← blocks at 53s on scenario 1
scan:gitleaks   [00:00 → 00:08]  ← blocks at 8s on scenario 3
scan:semgrep    [00:00 → 01:15]
scan:grype      [00:00 → 02:01]
```

Total wall-clock time equals the slowest scanner (grype ~2m), not the sum
(~6m). This confirms the five stages execute in parallel.
