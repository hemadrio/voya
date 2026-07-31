# Test Strategy

**Version:** 1.0  
**Owners:** Platform Engineering, Security & Quality Engineering  
**Last updated:** 2026-01-15

---

## Overview

The travel platform enforces a three-tier testing pyramid:

| Tier | Scope | Framework | Infrastructure required | WO |
|---|---|---|---|---|
| **Unit** | Domain logic, pure functions, factories | Vitest + V8 coverage | None (fakes injected) | WO-094 |
| **Contract** | API shape compatibility between services | Vitest (Zod baseline comparator) | None | WO-005 |
| **Integration / E2E** | Cross-service flows, DB round-trips, UI journeys | Vitest / Playwright | Docker Compose stack | WO-096 / WO-097 |

This document covers the **unit tier** established in WO-094.

---

## Running tests locally

```bash
# Run all unit tests across the workspace (affected packages only via Turborepo)
pnpm test:unit

# Run tests in a single package
cd services/booking-service
pnpm test

# Run with coverage output (generates coverage/ in each package)
pnpm test:unit -- --coverage

# Evaluate per-path coverage thresholds after generating reports
pnpm coverage:check

# Watch mode (development)
cd services/auth-service
npx vitest
```

---

## Framework and configuration

**Framework:** Vitest 1.x with the V8 coverage provider (ratified in ADR-0003).

Every service and shared package imports from `@travel/test-config`:

```typescript
// services/my-service/vitest.config.ts
import { createBaseConfig } from "@travel/test-config";
export default createBaseConfig();
```

`createBaseConfig()` provides:
- `environment: "node"`
- `include: ["test/**/*.test.ts", "__tests__/**/*.test.ts"]`
- Coverage: V8 provider, reporters `text + lcov + json-summary`, written to `./coverage/`

Override options by passing a partial `InlineConfig`:

```typescript
export default createBaseConfig({
  setupFiles: ["./test/setup.ts"],
  coverage: { include: ["src/domain/**/*.ts"] },   // narrow to domain layer only
});
```

---

## Coverage thresholds and phase gate mapping

Coverage is enforced **per path**, not as a single global percentage, so Phase 1 and
Phase 2 gates can be activated independently without changing test code.

| Phase | Path | Metric | Threshold | Activated |
|---|---|---|---|---|
| Phase 1 | `services/auth-service/src/domain/**` | lines + branches | 60 % | ✅ Active |
| Phase 1 | `services/search-service/src/domain/**` | lines + branches | 60 % | ⏳ When domain/ created |
| Phase 2 | `services/booking-service/src/domain/**` | lines + branches | 60 % | ✅ Active |
| Phase 2 | `services/payment-service/src/domain/**` | lines + branches | 60 % | ⏳ When domain/ created |

The script (`scripts/coverage-check.ts`) is run in the pipeline's `build:node` step
after `pnpm test:unit -- --coverage`. It exits non-zero with a per-path failure summary
when any active threshold is not met.

### Adding a new gated path

1. Add a domain layer under `services/<name>/src/domain/`.
2. Add a `ThresholdConfig` entry in `scripts/coverage-check.ts` (or un-comment the
   pre-configured entry for that service).
3. Write unit tests that achieve ≥ 60 % line and branch coverage.
4. Run `pnpm test:unit -- --coverage && pnpm coverage:check` to verify locally.

---

## Architecture rule: domain import boundary

An ESLint `no-restricted-imports` rule (in `eslint.config.js`) **fails** the lint step
when any file under `services/*/src/domain/**/*.ts` imports:

- `express` — domain services must not depend on the HTTP framework
- `@prisma/client` — domain services must not depend on the ORM directly

Use constructor-injected interfaces instead:

```typescript
// ✅ Correct — duck-typed repository interface injected at startup
export interface UserRepository {
  findById(id: string): Promise<User | null>;
}
export function createUserService(repo: UserRepository) { ... }

// ✗ Forbidden — direct ORM import in domain layer
import { PrismaClient } from "@prisma/client";
```

This rule keeps unit tests infrastructure-free: no running Postgres or Express server
is needed to test domain logic.

---

## Writing a domain unit test

All domain tests must:

1. Import domain code via relative path (e.g. `../../src/domain/MyService.js`).
2. Inject fakes via constructor — no `vi.mock()` module hoisting.
3. Import test utilities from `vitest` explicitly (`describe`, `it`, `expect`, `vi`).
4. Pass with `DATABASE_URL` unset (the `describe.skipIf(!process.env.DATABASE_URL)`
   pattern belongs in integration tests, not unit tests).

```typescript
import { describe, it, expect, vi } from "vitest";
import { createBookingService } from "../../src/domain/BookingService.js";
import type { BookingRepository } from "../../src/domain/BookingRepository.js";

function makeRepo(overrides: Partial<BookingRepository> = {}): BookingRepository {
  return {
    findById: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("BookingService.cancel", () => {
  it("throws LIFECYCLE_CONFLICT when booking is already CANCELLED", async () => {
    const repo = makeRepo({
      findById: vi.fn(async () => ({ id: "b1", status: "CANCELLED" })),
    });
    const svc = createBookingService({ repo });
    await expect(svc.cancel("b1")).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
  });
});
```

---

## Mandatory scenario checklist

See [`docs/testing/mandatory-scenario-checklist.md`](./mandatory-scenario-checklist.md)
for the high-risk branches that must have an explicit named test per the SOC 2 change-management
review process.

---

## Coverage artefact retention

| Artefact | Format | Location | Retention |
|---|---|---|---|
| Coverage report | `lcov` (`.info`) | Per-package `coverage/lcov.info`, archived as pipeline artefact | **1 year** (S3 `travel-platform-ci-artefacts` bucket, lifecycle rule `ci-coverage-1yr`) |
| Coverage summary | `json-summary` | Per-package `coverage/coverage-summary.json`, archived with lcov | **1 year** |
| Test results | JUnit XML | Per-package `coverage/junit.xml` (via `--reporter=junit`), archived | **1 year** |
| SonarQube | Coverage via `lcov` ingestion | `scan:sonarqube` step in `forge/pipeline.yml` | Retained in SonarQube project history |

**SOC 2 note:** Coverage and test-result artefacts are immutable (S3 Object Lock, COMPLIANCE
mode, 365-day retention) from Phase 0 onward. This satisfies the Audit Logging policy
requirement for change-management evidence before revenue.

The retention location to reference in SOC 2 Change Management control CC6.1 is:  
`s3://travel-platform-ci-artefacts/coverage/<git-sha>/`

---

## Adding a new service

1. Create `services/<name>/vitest.config.ts` importing from `@travel/test-config`.
2. Add `"@travel/test-config": "workspace:*"` to `devDependencies` in `services/<name>/package.json`.
3. Add `"test": "vitest run"` to the `scripts` block.
4. If the service has a domain layer (`src/domain/`), add a threshold entry to
   `scripts/coverage-check.ts`.
5. Turborepo picks up the new `test` task automatically via the wildcard glob in `turbo.json`.

---

## Useful commands reference

| Command | Effect |
|---|---|
| `pnpm test:unit` | Run all unit tests (affected packages, Turborepo cache) |
| `pnpm test:unit -- --coverage` | Run with V8 coverage output |
| `pnpm coverage:check` | Evaluate per-path thresholds (exits non-zero on failure) |
| `pnpm lint` | Run ESLint including domain-boundary rule |
| `cd services/X && pnpm test` | Run a single service's tests |
| `cd services/X && npx vitest --reporter=verbose` | Watch + verbose output |
