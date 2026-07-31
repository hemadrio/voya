# Credential Service

This document covers password policy, hash format, cost parameters and the
hash-upgrade procedure for the `CredentialService` (WO-019).

---

## Password Policy

| Rule | Value | Error code |
|---|---|---|
| Minimum length | 12 characters | `MIN_LENGTH` |
| Maximum length | 128 characters | `MAX_LENGTH` |
| Common passwords | Blocked via committed fixture list | `COMMON_PASSWORD` |
| Email local part | Must not appear in password (case-insensitive) | `CONTAINS_EMAIL_LOCAL` |

Violations are returned as a structured array of `PolicyViolation` objects so
the calling HTTP layer can map them to a 422 response with field-level errors.
The service never throws on policy failures.

---

## Hash Format

All new hashes use a PHC-inspired format:

```
$scrypt$n=<N>,r=<r>,p=<p>,kl=<keyLen>$<hex-salt>$<hex-hash>
```

Example:
```
$scrypt$n=32768,r=8,p=1,kl=64$a3b4c5d6e7f8....$deadbeef01234...
```

The `hash_algorithm` column on the `credentials` table stores `scrypt` (or
`argon2id` once that package is installed) to allow bulk migration queries
without parsing every hash string.

### Legacy format

The previous `crypto/password.ts` produced:
```
scrypt:<hex-salt>:<hex-hash>
```

`verifyPassword` detects this prefix and sets `needsRehash=true` on every
successful verification, prompting the caller to upgrade to the PHC format.

---

## Cost Parameters

| Environment | N | r | p | Comment |
|---|---|---|---|---|
| Production | 32768 (2^15) | 8 | 1 | OWASP 2023 recommendation × 2 |
| Test | 1024 (2^10) | 8 | 1 | Fast; keeps test suites under 100 ms |

Set `CREDENTIAL_TEST_MODE=1` or `NODE_ENV=test` to activate the cheap
parameters.

**Production floors** — never configure below:
- N ≥ 16384 (2^14)
- r ≥ 8
- p ≥ 1

### Upgrading to Argon2id (recommended)

1. Install the `argon2` npm package and add it to the catalog
2. Implement `Argon2Hasher` (see `CredentialService.ts` — the hash format is
   designed to accommodate a `$argon2id$v=19$...` prefix)
3. Change `ALGORITHM_NAME` and `encodeHash` to emit `$argon2id$...` hashes
4. The `needsRehash` logic will automatically trigger for all existing
   `$scrypt$...` hashes on the next successful login

---

## Hash-Upgrade Procedure

Transparent rehash happens at login time:

```
1. Look up credentials.secret_hash for the user
2. Call verifyPassword(plaintext, storedHash)
3. If result.valid && result.needsRehash:
   a. Call hashPassword(plaintext) → new hash + algorithm
   b. Update credentials SET secret_hash = <new hash>, hash_algorithm = <alg>
   c. Continue the login flow as normal
```

No separate migration job is needed — hashes upgrade organically as users log
in. To force immediate migration, run a bulk job that iterates over all
credentials with `hash_algorithm != 'argon2id'` and re-hashes with a server-side
known value (only possible during a password reset, not transparently).

---

## Lockout Policy

| Parameter | Default | Description |
|---|---|---|
| `threshold` | 5 | Consecutive failures before first lockout |
| `baseDelayMs` | 5 minutes | Initial lockout window |
| `maxDelayMs` | 24 hours | Maximum lockout window |

Lockout duration formula (exponential backoff):
```
lockDurationMs = min(baseDelayMs × 2^(failureCount - threshold), maxDelayMs)
```

At threshold 5:
| Failure count | Lock duration |
|---|---|
| 5 | 5 min |
| 6 | 10 min |
| 7 | 20 min |
| 8 | 40 min |
| 9 | 80 min |
| 10+ | ≤ 24 hours (cap) |

---

## Common Password List

The fixture lives at `services/auth-service/test/fixtures/common-passwords.txt`.
Each line is one password (case-insensitive comparison at check time).

To swap in a larger list (e.g. HaveIBeenPwned top-100k):
1. Replace the file contents with the new list
2. Re-run `vitest` to confirm the policy tests still pass
3. Note that startup time increases with list size (it's loaded into a `Set`)
   — for lists > 1M entries consider a Bloom filter

---

## Timing Safety

`verifyPassword(password, null)` — called when the user does not exist — runs a
comparison against a precomputed dummy hash so the response time is
indistinguishable from the existing-user path. The dummy hash is computed once
at service construction and reused for all null-hash calls.

The integration timing test asserts that the unknown-user median latency is
within 3× of the existing-user median (generous tolerance for CI environments
that may have high variance).
