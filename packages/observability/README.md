# @travel/observability

Pino JSON logger factory for the travel platform. Provides compile-time typed request context, PII redaction configured at construction, and CloudWatch Logs Insights-compatible single-line JSON output.

## Quick start

```ts
import { createLogger, createChildLogger } from '@travel/observability';

// Construct once per process (not once per request).
const logger = createLogger({ service: 'booking-service' });

// Per-request child — merges typed context, inherits all redaction rules.
const reqLogger = createChildLogger(logger, {
  correlationId: req.headers['x-correlation-id'],
  traceId:       req.headers['x-trace-id'],
  userId:        actor.sub,
  operation:     'create-booking',
  resource:      'bookings',
});

reqLogger.info({ bookingId: 'bk-001' }, 'booking confirmed');
```

## API

### `createLogger(options, destination?)`

| Option | Type | Required | Description |
|---|---|---|---|
| `service` | `string` | ✓ | Service name embedded in every log line |
| `version` | `string` | — | Image tag / semver from `IMAGE_TAG` env var |

Pass a `Writable` stream as `destination` to redirect output (useful in tests). Without `destination`, logs go to `process.stdout`.

Throws at startup if:
- `service` is empty
- `LOG_LEVEL` is set to an unrecognised level (fail-fast — no silent default)

### `createChildLogger(parent, context)`

Creates a Pino child logger that inherits all redaction settings from `parent` and merges the supplied `LogContext` bindings. Only defined (non-`undefined`) fields are added to the child.

### `LogContext` interface

```ts
interface LogContext {
  correlationId?: string;
  traceId?:       string;
  userId?:        string;
  operation?:     string;
  resource?:      string;
  supplierName?:  string;
  bookingId?:     string;
}
```

No index signature — callers cannot inject arbitrary keys. Pass ad-hoc fields in the log call's object argument: `logger.info({ extra: 'value' }, 'msg')`.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `LOG_LEVEL` | `info` | One of: `trace debug info warn error fatal`. Invalid values cause a startup error. `debug` is silently promoted to `info` in production. |
| `NODE_ENV` | — | `development` enables pino-pretty (if installed). All other values emit pure JSON. |
| `IMAGE_TAG` | — | Passed as `version` option to stamp logs with the image tag. |

## PII redaction path list

Redaction is configured **once at construction** using Pino's `redact` option. The following paths are covered at every nesting depth (up to four levels, plus array elements):

| Field | Typical location |
|---|---|
| `email` | Traveler profile, registration payload, marketing events |
| `passwordHash` | Auth service internal state (should never reach a log — belt-and-suspenders) |
| `dateOfBirth` | Traveler profile, passenger manifest |
| `passportNumber` | Booking passenger info |
| `headers.authorization` | Bearer tokens in HTTP request context |
| `headers["stripe-signature"]` | Stripe webhook signature header |

Redacted values are replaced with the literal `[REDACTED]` — the key remains visible for debuggability, only the value is masked.

**String-level scrubbing:** Error `message` and `stack` strings are additionally scrubbed for email-like patterns and long digit sequences via the custom error serializer, because Pino redact paths cannot reach inside string values.

## Log retention decisions (ADR-0001)

| Store | Retention | Mutable? |
|---|---|---|
| Application logs (CloudWatch Logs) | **30 days** | Yes — logs may be deleted after retention expires |
| Audit records (append-only audit store) | **1 year minimum** | No — immutable writes, cryptographic erasure on deletion |

Application logs and audit records are **distinct stores**. A `booking.confirmed` audit row written to the append-only `booking_audit_log` table is governed by the 1-year policy; the Pino JSON line emitted by the same code path is governed by the 30-day CloudWatch policy. Never use application logs to satisfy audit retention requirements.

See `docs/adr/0001-logging-and-test-runner.md` for the full decision record.

## Dependency injection policy

The logger is constructed **once per process** (in the service's entry point) and injected into controllers and domain services as a constructor parameter or function argument. Modules must not import a module-level singleton logger from deep inside domain code. This ensures the logger is always testable, mockable, and carries correct base bindings from startup.

## Running tests

```sh
pnpm test             # Jest 29 unit + integration tests
pnpm test:coverage    # With coverage (≥ 60% statement threshold)
pnpm typecheck        # tsc --noEmit strict mode
pnpm lint             # ESLint with no-console rule
```

Tests run fully offline — no external services, real PII, or environment setup required.
