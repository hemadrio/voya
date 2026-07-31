# Monorepo Tooling

This document covers the workspace topology, dependency catalog, Turborepo task graph, remote-cache configuration, and workspace-lint gate for the travel platform monorepo.

---

## Table of Contents

1. [Workspace layout](#workspace-layout)
2. [pnpm catalog — dependency version policy](#pnpm-catalog)
3. [Turborepo task graph](#turborepo-task-graph)
4. [Remote caching](#remote-caching)
5. [Toolchain version pinning](#toolchain-version-pinning)
6. [Workspace lint gate](#workspace-lint-gate)
7. [Common commands](#common-commands)
8. [Troubleshooting](#troubleshooting)

---

## Workspace layout

```
travel-platform/
├── packages/           # Shared library packages
│   ├── auth/           # @travel/auth      — JWT key rotation
│   ├── config/         # @travel/config    — DB URL builder, secrets validation
│   ├── contracts/      # @travel/contracts — Zod schemas + inferred TS types
│   ├── observability/  # @travel/observability — Pino logger, OTel bootstrap
│   ├── queue/          # @travel/queue     — AMQP/SQS queue port
│   ├── supplier-port/  # @travel/supplier-port — SupplierPort abstraction
│   └── suppliers/      # @travel/suppliers — HTTP client, egress policy
├── services/           # Deployable microservices (9 total)
│   ├── ai-service/
│   ├── auth-service/
│   ├── booking-service/
│   ├── itinerary-service/
│   ├── notification-service/
│   ├── payment-service/
│   ├── reporting-service/
│   ├── search-service/
│   └── user-service/
├── frontend/           # Next.js 14 App Router web app
├── tools/
│   └── workspace-lint/ # @travel/workspace-lint — catalog/protocol validator
└── infra/              # Terraform modules, Docker Compose stack
```

`pnpm-workspace.yaml` declares the globs:

```yaml
packages:
  - "packages/*"
  - "services/*"
  - "frontend"
  - "tools/*"
```

---

## pnpm catalog

The `catalog:` section in `pnpm-workspace.yaml` pins **one version** for every shared runtime and build-tool dependency. Packages reference entries with the `"catalog:"` version string rather than a literal semver.

### Why catalogs

Without a catalog, the same SDK can land at divergent minor or patch versions across services, producing invisible runtime differences and failed CI comparisons. The catalog makes the version the single source of truth.

### Using a catalogued dependency

```json
// package.json
"dependencies": {
  "zod": "catalog:",
  "pino": "catalog:"
}
```

### Named catalogs (exceptional use only)

If a package legitimately requires a different major of a catalogued dependency, create a named catalog entry and document the justification in a comment:

```yaml
# pnpm-workspace.yaml
catalogs:
  legacy-zod3:
    # legacy-reporter-tool requires zod 3.x — tracked in WO-XXX for migration
    zod: "^3.22.0"
```

```json
"dependencies": {
  "zod": "catalog:legacy-zod3"
}
```

**The workspace lint gate blocks any un-catalogued reference to a catalogued dependency without an explicit justification.**

---

## Turborepo task graph

Tasks are defined in `turbo.json`. The dependency graph ensures shared packages build before their consumers and contract generation precedes any typecheck.

### Key edges

| Task | Depends on | Cached |
|------|-----------|--------|
| `contract:gen` | _(nothing)_ | ✓ |
| `build` | `^build`, `contract:gen` | ✓ |
| `typecheck` | `^build`, `contract:gen` | ✓ |
| `lint` | `^build` | ✓ |
| `test` / `test:unit` | `^build` | ✓ |
| `test:integration` | `^build` | ✗ (requires Compose stack) |
| `dev` | `^build` | ✗ (persistent) |
| `clean` | — | ✗ |

### Running tasks

```bash
# Build all packages in dependency order
pnpm build

# Only typecheck affected packages since last commit
pnpm turbo run typecheck --filter=...[HEAD^1]

# Run tests for a single package and its dependents
pnpm turbo run test --filter=@travel/contracts...

# Full pipeline
pnpm turbo run build typecheck lint test
```

### Affected-package filtering

Turborepo computes which packages changed relative to a base ref. In CI, pass `--filter=...[origin/main]` to rebuild only affected packages.

---

## Remote caching

Remote caching lets CI runners and developer machines share build artefacts so clean checkouts skip already-passing tasks.

### Environment variables

| Variable | Required in CI | Description |
|----------|---------------|-------------|
| `TURBO_TOKEN` | Yes | Access token for the Vercel/self-hosted cache endpoint |
| `TURBO_REMOTE_CACHE_SIGNATURE_KEY` | Yes | Secret key used to sign artefact hashes |
| `TURBO_TEAM` | Yes | Team slug on the cache server |
| `TURBO_API` | Recommended | Cache server URL (defaults to `https://vercel.com`) |

**These are secrets. Never commit them. Never print them in build logs.**

### Graceful degradation

If `TURBO_TOKEN` is absent or the cache endpoint is unreachable, Turborepo falls back to local filesystem caching and logs a warning. The build never fails due to cache unavailability.

### Local setup (optional)

```bash
export TURBO_TOKEN=<your-token>
export TURBO_REMOTE_CACHE_SIGNATURE_KEY=<signing-secret>
export TURBO_TEAM=<your-team>
# Then run as normal — turbo will warm the remote cache
pnpm build
```

---

## Toolchain version pinning

### Node.js

All packages declare `"engines": { "node": ">=20.0.0 <21.0.0" }`. The root `package.json` also declares this range. If you run `pnpm install` with a different Node version, the preinstall guard will exit non-zero:

```
[preinstall] ERROR: Node v18.20.0 does not satisfy engines.node: ">=20.0.0 <21.0.0".
  Remediation:
    nvm use 20
    fnm use 20
    volta install node@20
```

Use [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), or [Volta](https://volta.sh/) to manage Node versions. An `.nvmrc` or `.node-version` file at the repo root is the canonical source.

### pnpm

The root `package.json` declares `"packageManager": "pnpm@9.7.1"`. Enable [Corepack](https://nodejs.org/api/corepack.html) to have it automatically activated:

```bash
corepack enable
# pnpm version is now enforced by Corepack from packageManager field
```

If the wrong package manager is detected, the preinstall guard will fail with:

```
[preinstall] ERROR: Wrong package manager. Expected pnpm@9.7.1.
  Remediation:
    corepack enable
    corepack use pnpm@9.7.1
```

### `.npmrc` settings

| Setting | Value | Effect |
|---------|-------|--------|
| `strict-peer-dependencies` | `true` | Peer conflicts fail install |
| `auto-install-peers` | `false` | Peers must be declared explicitly |
| `shamefully-hoist` | `false` | No phantom dependencies |
| `public-hoist-pattern` | `[]` | Nothing hoisted to root |
| `engine-strict` | `true` | Enforces engines constraints at install time |

---

## Workspace lint gate

The `@travel/workspace-lint` CLI validates every workspace manifest against three rules:

### Rules

1. **catalog-drift** — Any dependency listed in the workspace catalog must use `"catalog:"` as its version. Literal semver strings are forbidden.

2. **workspace-protocol** — Internal `@travel/*` dependencies must use `"workspace:*"` (or `workspace:^`). Registry versions are forbidden.

3. **engines-consistency** — Every package must declare `engines.node` compatible with the root minimum (`>=20`).

### Running the lint gate

```bash
# From repo root
pnpm workspace:lint

# Or directly
tsx tools/workspace-lint/src/index.ts --root .
```

### Example output

```
Workspace lint — checked 17 package(s)

packages/auth/package.json
  [catalog-drift] dependencies.typescript
    expected: catalog:
    actual:   ^5.4.5

services/booking-service/package.json
  [engines-consistency] engines.node
    expected: >=20.0.0 <21.0.0
    actual:   (missing)

✖  2 violation(s) in 2 file(s)
```

### Fixing violations

1. **catalog-drift**: Replace the literal version with `"catalog:"` in the affected `package.json`.
2. **workspace-protocol**: Replace `"^0.1.0"` with `"workspace:*"` for `@travel/*` dependencies.
3. **engines-consistency**: Add `"engines": { "node": ">=20.0.0 <21.0.0" }` to the manifest.

---

## Common commands

```bash
# Install all dependencies
pnpm install

# Build all packages (Turborepo-orchestrated)
pnpm build

# Typecheck entire workspace
pnpm typecheck

# Lint entire workspace
pnpm lint

# Run all unit tests
pnpm test:unit

# Run integration tests (requires local Compose stack)
docker compose up -d && scripts/wait-for-stack.sh
pnpm test:integration

# Start dev servers
pnpm dev

# Clean all build artefacts
pnpm clean

# Run workspace lint validation
pnpm workspace:lint

# Run a single package's build
pnpm turbo run build --filter=@travel/contracts
```

---

## Troubleshooting

### `pnpm install` fails with peer dependency errors

Ensure `strict-peer-dependencies=true` is in `.npmrc`. Fix peer violations explicitly — do not add `--no-strict-peer-dependencies`.

### `Module not found: @travel/contracts`

The contracts package must be built before consumers typecheck. Run:

```bash
pnpm turbo run build --filter=@travel/contracts
```

Or run a full build first: `pnpm build`.

### Remote cache miss after source change

This is expected. Turborepo re-runs tasks for affected packages and uploads new artefacts. A subsequent unchanged run should hit the cache.

### `TURBO_REMOTE_CACHE_SIGNATURE_KEY` not set

The build falls back to local cache — this is a warning, not an error. Set the env var in CI via your secrets manager. Never hardcode it.

### Workspace lint reports false positives

If a package legitimately needs a non-catalog version, use a named catalog in `pnpm-workspace.yaml` and reference it with `"catalog:<name>"`. Document the justification in a YAML comment.

### Node version mismatch in CI

Ensure your CI runner `setup-node` step matches the version in `engines.node`. Example (GitHub Actions):

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'pnpm'
```

### Lockfile drift

If CI fails with a frozen lockfile error, run `pnpm install` locally, commit the updated `pnpm-lock.yaml`, and push. CI always uses `pnpm install --frozen-lockfile`.
