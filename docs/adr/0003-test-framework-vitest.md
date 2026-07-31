# ADR-0003: Ratify Vitest as the Platform-Wide Unit-Test Framework

**Date:** 2026-01-15  
**Status:** Accepted  
**Deciders:** Platform Engineering, Security & Quality Engineering  
**Supersedes:** ADR-0001 §Test runner (which left the choice open for new packages and ratified Jest 29 only for `@travel/observability` as a temporary measure)

---

## Context

At the start of Phase 0 the monorepo had a single test file with three Jest 29 tests
across eight Express services.  
ADR-0001 ratified Jest 29 for `@travel/observability` to avoid the ESM/Jest experimental-VM-modules
flag while keeping `@travel/contracts` on Vitest, but explicitly deferred a platform-wide decision.

WO-094 requires that:

1. One standard test configuration is shared by every service and package via Turborepo.
2. Coverage is collected in `lcov` + `json-summary` format for SonarQube ingestion and SOC 2 retention.
3. The framework runs under TypeScript `strict` mode with no `any` escape hatches.
4. Tests run offline (no network, DB, Redis, or queue).
5. The framework integrates cleanly with pnpm workspaces and Turborepo remote caching.

---

## Decision

**Vitest 1.x with the V8 coverage provider** is ratified as the single unit-test framework
for all services and packages in this monorepo, effective immediately.

`@travel/observability` (previously on Jest 29) is migrated to Vitest as part of this ADR.  
All remaining Jest configuration files (`jest.config.cjs`, `ts-jest`) are superseded.

---

## Rationale

| Criterion | Vitest 1.x | Jest 29 + ts-jest |
|---|---|---|
| Native ESM (no `--experimental-vm-modules`) | ✅ Yes | ❌ Requires flag or CommonJS shim |
| TypeScript strict mode without transform overhead | ✅ Built-in, via Vite | ⚠️ Requires ts-jest with per-file compilation |
| pnpm workspace & Turborepo integration | ✅ First-class (same Vite config graph) | ⚠️ Manual `moduleNameMapper` for `.js` extension imports |
| V8 coverage with lcov + json-summary | ✅ Built-in `@vitest/coverage-v8` | ⚠️ Requires `jest-coverage-provider-v8` or Istanbul |
| Watch mode / HMR in development | ✅ Fast (Vite HMR) | ⚠️ Slower cold start |
| Inline snapshot & concurrent test support | ✅ Yes | ⚠️ Limited in v29 |
| Migration cost from Jest | ✅ Low: `vi` API mirrors `jest` API | N/A |

**Key factors that made Jest untenable at scale:**  
- `NodeNext` module resolution requires `.js` extensions in imports; ts-jest's `moduleNameMapper`
  is a fragile workaround that breaks on new packages.  
- ADR-0001 already chose Vitest for `@travel/contracts`; a split framework doubles tooling
  maintenance cost and prevents a shared `@travel/test-config` package.

---

## Migration of pre-existing Jest tests

The three original Jest test files (all in `@travel/observability/__tests__/`) have been
migrated by:

1. Replacing `jest.fn()` → `vi.fn()`, `jest.spyOn()` → `vi.spyOn()`, `jest.restoreAllMocks()` → `vi.restoreAllMocks()`.
2. Adding explicit `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"` to each file.
3. Replacing the `jest.Mock` type with `ReturnType<typeof vi.fn>` and `jest.SpyInstance` with `MockInstance` from vitest.
4. Replacing `jest.config.cjs` + `ts-jest` with a `vitest.config.ts` that extends `@travel/test-config`.
5. Removing `jest`, `ts-jest`, and `@types/jest` from `devDependencies`; adding `vitest`.

All three test files pass under Vitest with no behaviour changes.

---

## Shared test configuration package

`packages/test-config` (`@travel/test-config`) is a new workspace package that exports
`createBaseConfig()` — a function returning a Vitest config with:

- `environment: "node"`  
- `include: ["test/**/*.test.ts", "__tests__/**/*.test.ts"]`  
- Coverage: V8 provider, reporters `["text", "lcov", "json-summary"]`, `reportsDirectory: "./coverage"`

Every service and package imports from `@travel/test-config` in its `vitest.config.ts`.

---

## Coverage gate

A per-path coverage threshold script (`scripts/coverage-check.ts`) reads the per-package
`coverage/coverage-summary.json` files and enforces:

| Phase | Path glob | Lines | Branches |
|---|---|---|---|
| Phase 1 | `services/auth-service/src/domain/**` | 60 % | 60 % |
| Phase 2 | `services/booking-service/src/domain/**` | 60 % | 60 % |

Phase 1 (search domain) and Phase 2 (payment domain) thresholds are pre-configured as
commented-out entries — they activate automatically when `src/domain/` is created in
those services.

---

## Architecture rule

An ESLint `no-restricted-imports` rule is added to `services/*/src/domain/**/*.ts` that
**fails** (not warns) when any file under a domain directory imports `express` or `@prisma/client`.
This rule enforces the constructor-injection boundary that keeps unit tests infrastructure-free.

---

## Consequences

- **Positive:** One framework, one config, one CI step; remote cache works correctly
  because coverage outputs are declared as Turborepo outputs.
- **Positive:** SonarQube ingests `lcov` directly; `json-summary` powers the threshold script.
- **Positive:** `vi` mirrors the Jest API closely enough that future Jest references are easy to spot.
- **Negative:** Packages that previously used Jest globals must add explicit vitest imports;
  this is a one-time migration per package.
- **Risk accepted:** `@travel/observability` depended on `@opentelemetry/sdk-node` initialisation
  in tests; the migration is validated by the existing `InMemorySpanExporter` test suite passing.

---

## References

- ADR-0001: Logging and test runner (Jest 29 for `@travel/observability`, deferred platform decision)  
- WO-094: Establish unit test harness with per-path coverage gate  
- Vitest docs: https://vitest.dev  
- SOC 2 evidence retention: see `docs/testing/test-strategy.md §Coverage artefact retention`
