# ADR-0005: Zod Contracts as Single Source of Truth over OpenAPI Code Generation

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Architecture Review
**Owner:** Platform Engineering

---

## Context

The platform has nine services and a Next.js frontend that must share request and response shapes without duplicating TypeScript interfaces. Without a single authoritative definition, a breaking API change is discovered at runtime rather than at build time. The security policy (A05 Injection) requires input sanitisation at every service boundary.

Three strategies were evaluated: (1) OpenAPI as the source of truth with generated TypeScript types, (2) a shared TypeScript DTOs package (hand-written types only), and (3) Zod schemas as the source of truth (types *and* runtime validators derived from a single declaration).

---

## Decision

The `@travel/contracts` workspace package holds Zod schemas as the single source of truth for every v1 request, response, event, and enum shape. TypeScript types are always derived via `z.infer`; hand-written interfaces are forbidden in this package. An OpenAPI 3.1 document is *generated from* the Zod schemas by `scripts/generate-openapi.ts` and committed; a drift check in the pipeline fails the build when the committed document no longer matches what the generator produces.

---

## Rationale

A Zod schema satisfies both the Type Safety and Input Sanitization policies in one declaration: `.parse()` at the service boundary is both the runtime validator and the TypeScript type guard. OpenAPI codegen tools typically produce TypeScript interfaces but not runtime validators, requiring a second pass (Ajv or equivalent) that can drift from the generated types. Hand-written DTOs provide type safety but no runtime validation.

The drift check closes the loop: the OpenAPI reference is generated (never hand-maintained), a schema change that is not reflected in the committed reference fails the build, and contract tests validate live responses against the same spec.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| OpenAPI 3.1 as source, generated TypeScript | Codegen produces interfaces without runtime validators; a second Ajv-or-equivalent pass can drift from the generated types; two files to keep in sync per schema |
| Hand-written TypeScript DTOs in `@travel/contracts` | Provides type safety but no runtime validation; each service must add its own validation layer, which can drift; does not satisfy A05 without additional tooling |
| gRPC with Protobuf | Protocol Buffers satisfy both type safety and validation but require a separate build step, binary transport, and significant tooling investment for a REST-first HTTP/JSON platform |
| tRPC | Excellent for same-language monorepo RPC but does not produce a vendor-neutral API surface; the guest allow-list and future third-party consumer requirements need a documented HTTP API |

---

## Consequences

**Positive:**
- A single `@travel/contracts` import satisfies both compile-time types and runtime validation at every service boundary.
- Breaking changes fail CI at the `contracts-check` pipeline step before any deploy.
- The OpenAPI reference is always in sync with the actual schemas (enforced by drift check).
- New services inherit validation by importing `@travel/contracts` rather than writing a new validator.

**Negative / Trade-offs:**
- Zod adds ~45 kB gzipped to any bundle that imports it; this is mitigated by importing per-domain barrel (`@travel/contracts/search`) rather than the root barrel in the browser.
- Complex Zod pipelines (transform + pipe, used for IATA codes and ISO dates) do not produce the richest OpenAPI schema descriptions; the generator uses the output-side schema as the OpenAPI representation.
- The drift check must regenerate the OpenAPI document in CI on every PR, which adds ~2 s to the pipeline; this is acceptable given the contract-safety benefit.

**Neutral / Notes:**
- The registry in `packages/contracts/src/openapi/registry.ts` must be updated whenever a new route is added. A gap in the registry (undocumented route) fails the drift check as soon as the route appears in source.
- `z.infer<typeof Schema>` is the canonical way to derive a TypeScript type; `interface Foo { ... }` is not permitted in `@travel/contracts`.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; enforced from WO-110 onward |
