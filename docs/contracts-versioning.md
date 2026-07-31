# @travel/contracts — Versioning policy and expand-and-contract rule

## Overview

`@travel/contracts` is the highest fan-in package in the repository: every
service and the web app resolve it through the pnpm workspace protocol.  A
single incompatible edit can break all nine services and the frontend at once,
so every change to this package must pass through the gate documented here.

---

## Semantic versioning

The package follows **strict semver**:

| Change type                                | Version bump |
|--------------------------------------------|--------------|
| Additive change (backward-compatible)      | Minor or patch |
| Breaking change                            | **Major** |

Examples:

- Adding an optional field to a response schema → **patch** or minor
- Adding a new schema to the registry → minor
- Removing any field (required or optional) → **MAJOR**
- Renaming a field → **MAJOR** (treated as removal + addition)
- Making an optional field required → **MAJOR**
- Narrowing an enum (removing a member) → **MAJOR**
- Changing a field type (e.g. `string → number`) → **MAJOR**
- Adding an enum member to a **request** schema → **MAJOR** (consumers may not handle it exhaustively)
- Adding an enum member to a **response** schema → minor or patch (consumers should handle unknown values)

---

## Expand-and-contract rule

To maintain **one version of backward compatibility** and keep rollbacks safe:

1. **Expand** — add the new field/value as **optional** in the same version.
   Services and the frontend that don't yet consume it continue to work.
2. **Coordinate** — update all consumers to handle both the old and new form.
3. **Contract** — in the *next* major version, remove the old form.

A removal or rename is never committed in the same version as the addition.

### Example: renaming a field

```
v1.2.0  — add `destinationCode?: string` alongside `destination: string`
          (all consumers still use `destination`)
v2.0.0  — remove `destination`; require `destinationCode`
          (all consumers have been updated to prefer `destinationCode`)
```

---

## How the CI gate works

### Baseline comparison

Every exported schema has a committed JSON Schema baseline in
`packages/contracts/contract-baselines/`.  The `@travel/contracts#test` task
(which is **non-cacheable** in turbo.json) regenerates these baselines in
memory and compares them to the committed files.

If the generated output differs from the committed file, the test fails with:
- The schema ID (`search.FlightSearchRequest`, `booking.CreateBookingRequest`, …)
- Instructions to run `pnpm --filter @travel/contracts generate:baselines`,
  review the diff, and commit the updated file.

A stale Turborepo remote cache hit cannot mask a real diff because the task is
explicitly non-cacheable.

### Breaking change → major version gate

The classifier (`test/compatibility/classifier.ts`) categorises the diff:

- **no-op** — nothing changed; gate passes unconditionally.
- **additive** — new optional field or new enum member on a response schema;
  gate passes without a version bump.
- **breaking** — removed field, newly required field, type change, narrowed
  enum, or new enum member on a request schema; gate fails unless the package
  `version` major has been incremented in the same commit.

### Consumer fixture tests

Each of the nine services and the frontend maintains fixture files in its own
`test/fixtures/` directory and a `test/contracts.consumer.test.ts` file that
parses each fixture with the specific contracts schemas it consumes.  A
narrowing change in contracts fails in the consumer that depends on it rather
than only in the contracts package's own tests.

---

## Updating a baseline

1. Edit the schema in `src/`.
2. Run `pnpm --filter @travel/contracts generate:baselines`.
3. Review the diff: confirm every change is intentional.
4. If any change is **breaking** (the classifier reports it), bump the major
   version in `packages/contracts/package.json`.
5. Update all consumer services' fixture files and tests to reflect the new shape.
6. Commit everything — baseline file, version bump, and consumer updates —
   **in a single commit**.

---

## Schema registry and completeness gate

Every public domain object schema is listed in `src/registry.ts`.  The
`test/registry.test.ts` completeness test asserts that:

1. Every registered schema has a committed baseline file.
2. Every committed baseline file corresponds to a registered schema.

A new schema added to `src/` but not to the registry escapes baseline coverage
silently.  The convention is: register the schema in the same PR that adds it.

---

## Test runner assumption (TA-001)

**Status: unratified assumption**

The harness currently uses **Vitest 1.x** as the test runner for all
contracts-package tests (`pnpm test` in `packages/contracts/`).  The
existing Jest 29 installation on some services has not been evaluated for
adoption in this package.

All assertion primitives are imported from
`test/compatibility/test-helpers.ts` rather than directly from `vitest`.
If the project migrates to Jest 29 only that file needs updating; no test
assertions require rewriting.

**Ratification owner:** tech lead / @contracts-steward
**Decision deadline:** prior to Phase 1 service scaffold (WO-006 milestone)
