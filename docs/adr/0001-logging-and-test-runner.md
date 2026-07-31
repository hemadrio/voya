# ADR-0001: Application Log Retention and Epic Test Runner

**Status:** Ratified  
**Date:** 2026-07-31  
**Deciders:** Platform Engineering, Security/Compliance  
**Ratification scope:** Phase 0 foundation work orders (WO-006 through WO-009)

---

## Context

Two parameters were left open at the start of the Phase 0 logging epic (WO-006):

1. **How long should application logs be retained in CloudWatch Logs?**  
   The answer determines CloudWatch Log Group configuration, cost exposure, and whether application logs could be misused to satisfy audit requirements.

2. **Which test runner governs the Phase 0 observability and service work orders?**  
   The `@travel/contracts` package (WO-005) uses Vitest 1.x. The nine services and the new `@travel/observability` package have no committed runner yet. Mixing two runners in the same epic creates unnecessary friction: dual `jest.config.*` vs `vitest.config.*`, different assertion APIs, different coverage reporters, and ambiguity about which runner "owns" integration tests that span both a service and the contracts package.

---

## Decision 1 — Application Log Retention: 30 Days

CloudWatch Log Groups for all service application logs are configured with a **30-day retention policy**.

### Rationale

- 30 days covers a typical security incident investigation window (industry baseline is 14–30 days for operational logs).
- AWS CloudWatch Logs pricing at ~2 MB/service/day across nine services ≈ 0.5 GB/month; 30-day retention keeps monthly storage under 15 GB — well within cost targets.
- Operations runbooks and post-incident reviews rarely require log data older than 30 days. Older data should have been summarised in metrics or traces.

### Critical distinction from audit record retention

**Application logs are not audit records.**

The platform's `booking_audit_log` table — written by the booking-service saga and payment-service webhook handler — is an **append-only, immutable audit store** governed by a **1-year minimum retention** requirement (SOC 2 + GDPR Article 5(1)(e)). That store:

- Is never cleaned up by the 30-day CloudWatch retention job.
- Is written via a separate code path (the audit writer, not the Pino logger).
- Undergoes cryptographic erasure on deletion rather than expiry.

Any engineering change that routes booking confirmations, payment completions, or access-control failures *only* to the Pino application log (and not to the audit store) violates the audit requirement regardless of the log retention setting.

### Consequences

- CloudWatch Log Groups must be provisioned with `retentionInDays: 30`.
- Services must not depend on application logs being available after 30 days (e.g., for cost reconciliation or compliance evidence).
- Compliance evidence for SOC 2 auditors comes from the append-only audit store, not from CloudWatch Logs.

---

## Decision 2 — Epic Test Runner: Jest 29

**Jest 29** (with `ts-jest` for TypeScript transformation) is the ratified test runner for all work orders in the Phase 0 logging and service-scaffold epic (WO-006 through WO-009, and the per-service consumer-test extensions in WO-010 through WO-018).

### Rationale

| Criterion | Jest 29 | Vitest 1.x |
|---|---|---|
| Maturity in Node.js + TypeScript | Proven at scale; large ecosystem | Rapidly maturing; fewer production case studies at service level |
| CommonJS compatibility | Native CJS + ESM hybrid via `ts-jest` | ESM-first; CJS interop needs extra config |
| Integration test support | Strong support for real HTTP, streams, and timers | Good support; some edge cases with Vite transform |
| `ts-jest` inline tsconfig | Allows per-package module overrides without extra config files | N/A |
| Existing usage in the monorepo | New — introduced with WO-006 | Already used in `@travel/contracts` |

The dual-runner situation (Vitest in `@travel/contracts`, Jest in services/observability) is intentional: `@travel/contracts` has no runtime I/O and benefits from Vitest's native ESM support for schema round-trip tests. Service-level tests involve Express, streams, and database clients where Jest's battle-tested mocking and real-I/O handling provide more reliable results. The TA-001 assumption documented in `packages/contracts/README.md` covers the path to unifying on one runner if the team later chooses to do so.

### Consequences

- `@travel/observability` and all nine services use Jest 29 + ts-jest.
- `jest.config.cjs` (CommonJS Jest config) is the standard config file name for service/observability packages.
- Coverage reports go to `coverage/` and are picked up by the Turborepo `test` task output definition.
- `@travel/contracts` continues to use Vitest 1.x; its tests are unaffected by this decision.
- A future unification effort (if desired) would migrate services from Jest to Vitest — the `test-helpers.ts` indirection in `@travel/contracts` is the rollback handle for that migration.

---

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| 90-day log retention | Increases CloudWatch cost ~3× with no compliance benefit; 30 days is the standard security-operations window |
| Permanent log retention | CloudWatch Logs is not an archival system; unbounded cost; audit requirements are satisfied by the dedicated audit store, not application logs |
| Vitest for services | ESM-first transform conflicts with Express + ts-jest CommonJS interop patterns used in service integration tests |
| Mocha/Chai | No TypeScript-native preset; more boilerplate; test runner fragmentation |
