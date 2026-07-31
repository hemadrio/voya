# ADR 0002 — OpenTelemetry Tracing: Sampling Policy and Telemetry Cost Rationale

**Status:** Accepted  
**Date:** 2026-07-31  
**Author:** Platform Engineering  
**Supersedes:** The non-functional sketch in `shared/instrumentation.ts` (deleted)

---

## Context

The platform has nine services calling each other, PostgreSQL, Redis,
RabbitMQ/SQS, and three external suppliers with no span data. The ratified
latency budgets cannot be measured or defended without distributed tracing:

| Journey            | p95 Budget |
|--------------------|------------|
| Search (cache hit) | ~180 ms    |
| Search (miss)      | ≤ 3,000 ms |
| Checkout ack       | ≤ 5,000 ms |
| Assistant 1st token| ≤ 2,000 ms |

AWS X-Ray + CloudWatch were selected by the architecture board (ADR 0001 context):
native IAM auth, no egress cost, no third-party data processor to add to the
GDPR record of processing.

---

## Decision

### SDK and propagation

The `@travel/observability` package exports `initTracing(options)` which
constructs an OpenTelemetry `NodeSDK` with:

| Component | Choice | Rationale |
|---|---|---|
| ID generator | `AWSXRayIdGenerator` | IDs are X-Ray-compatible (epoch-prefixed, 96-bit random) so traces link directly to X-Ray service map without ID translation |
| Propagators | `CompositePropagator([AWSXRayPropagator, W3CTraceContextPropagator, W3CBaggagePropagator])` | AWS-native services send X-Ray headers; OTel services use W3C traceparent; W3C baggage carries the WO-007 correlation ID |
| Exporter | OTLP/HTTP to `http://localhost:4318/v1/traces` | ADOT sidecar shares the ECS task network namespace; no TCP hop, negligible latency |
| Endpoint override | `OTEL_EXPORTER_OTLP_ENDPOINT` env var | Lets docker-compose dev stack point at a local collector container |
| Auto-instrumentation | `@opentelemetry/auto-instrumentations-node` | Covers HTTP, Express, Prisma/pg, Redis (v4 + v5), amqplib, AWS SDK without per-library boilerplate |
| Disabled | `@opentelemetry/instrumentation-fs` | File-system reads would generate ~50× the span volume of request spans; excluded to stay within cost budget |
| Health-check exclusion | `/health`, `/health/live`, `/health/ready` | ALB sends ~6 probes/minute per task (54 probes/min at min capacity); excluded to avoid flooding X-Ray |

### Sampling policy

A pure head-based approach cannot satisfy the "always capture error/slow traces"
requirement because sampling is decided at trace start, before errors are known.
A full tail sampler would require a central buffering service (high cost, new
infra dependency). This ADR ratifies a hybrid:

**Stage 1 — AlwaysRecordSampler (head phase)**

Delegates to `ParentBased(TraceIdRatioBased(0.1))` but overrides `NOT_RECORD`
to `RECORD_ONLY`. Every span is created in memory; 10% of root traces are marked
`RECORD_AND_SAMPLED` (will be exported via `BatchSpanProcessor`); 90% are marked
`RECORD_ONLY` (in memory only, negligible cost: ~200 bytes per span).

**Stage 2 — ErrorAndSlowSpanProcessor (tail override)**

Inspects every `RECORD_ONLY` span at `onEnd()`:
- `span.status.code === SpanStatusCode.ERROR` → export immediately
- `hrTimeToMilliseconds(span.duration) > latencyBudgetMs` → export immediately

`RECORD_AND_SAMPLED` spans are ignored by this processor (they are handled by
`BatchSpanProcessor`).

This achieves:
- 10% normal traffic sampled (predictable cost)
- 100% error / slow traces exported (operations visibility)
- No central buffer service required

**Parent-based propagation**: when an upstream span arrives marked sampled,
the child service respects that decision and exports the full sub-trace. This
preserves connected traces for sampled traffic across service hops.

### Cost rationale

Target: approximately USD 240 per month.

```
Services:         9
Tasks per svc:    3 (min capacity)
Requests/task:   ~33 rps average (300 rps total / 9 services)
Spans/request:    5 average (gateway, service, redis, prisma, supplier)
Sampling ratio:  10%

Sampled spans/sec = 9 × 3 × 33 × 5 × 0.10 ≈ 445 spans/sec
Sampled spans/month = 445 × 86400 × 30 ≈ 1.15 billion

AWS X-Ray pricing (us-east-1, 2026):
  First 100k traces/month:  free
  Then $5.00 per 1M traces

Estimated traces/month (≈1 span = 1 segment):
  At 5 spans/trace → 1.15B spans / 5 ≈ 230M traces → ~$1,150/month

Correction: X-Ray charges per trace (root segment), not per span.
  At 10% sampling: 300 rps × 10% = 30 root traces/sec
  30 × 86400 × 30 = 77.76M traces/month
  77.76M × $5/1M = $388.80/month (slightly over $240 target)

Mitigation options applied:
  1. Ratio reduced to 10% (already applied) — tune to 6-7% in production to
     hit the $240 target; start at 10% for initial baselining.
  2. Health-check exclusion saves ~3% of probe-only traces.
  3. fs instrumentation disabled saves ~40% of span count.

At 7% sampling the estimate is $388.80 × 0.7 ≈ $272/month — within 15% of
the $240 target and acceptable for the phase-0 period.  Review after 30 days
of production traffic data; reduce ratio or add sampling rules by service
if needed.
```

### Redis v4 vs v5 compatibility

- `search-service`, `user-service`: will use redis v4 via `ioredis ^5.3.2`
  (ioredis 5 maps to redis wire protocol v4 — the instrumentation covers it)
- `booking-service`, `notification-service`: will use `ioredis ^5.3.2` as well

The `@opentelemetry/auto-instrumentations-node` package as of 0.49.1 includes
`@opentelemetry/instrumentation-ioredis` which covers both ioredis 4.x and 5.x.
Native `redis` v4/v5 clients (the `redis` npm package) use
`@opentelemetry/instrumentation-redis-4`.  If any service introduces the
`redis` npm package, verify instrumentation coverage and add explicit manual
spans in the cache repository layer if the auto-instrumentation does not cover
the client version in use.

### Graceful shutdown

`initTracing()` registers `process.once('SIGTERM', shutdown)` and
`process.once('SIGINT', shutdown)`.  `shutdownTracing()` races
`sdk.shutdown()` against a 5-second timeout.  A timeout logs a warning and
returns, allowing ECS task stop to proceed — no spans are worth blocking a
deployment.

### Startup ordering

`initTracing()` must be the first statement executed in a service entrypoint.
Each service has a `src/tracing.ts` that calls `initTracing()`, imported as the
first static import in `src/index.ts`.  In Node.js ES modules, static imports
are evaluated depth-first before any module body runs, so `tracing.ts` executes
before Express, Prisma, or Redis are loaded — the auto-instrumentation shimmer
is installed before those modules register their exports.

---

## Consequences

**Positive**
- Latency budgets can be measured and alarmed on in WO-011.
- Error traces are always captured regardless of head-sampling ratio, giving
  operators full visibility into production failures without 100% sampling cost.
- X-Ray service map is populated from day 1 of phase-0 rollout.
- WO-007's `getTraceId()` now returns a real X-Ray-format trace ID when the SDK
  is bootstrapped, making `error.reference` in API responses directly linkable
  to X-Ray.

**Negative / trade-offs**
- `AlwaysRecordSampler` creates span objects for the 90% of un-sampled traces.
  Each span is ~200 bytes in heap; at 300 rps with 5 spans each, un-sampled
  overhead is approximately 270 kB/sec — negligible against typical service heap.
- The 10% sampling ratio may miss sporadic slow requests that are not errors.
  WO-011 will add P95 latency alarms which compensate for this visibility gap.
- `OTEL_EXPORTER_OTLP_ENDPOINT` must be set in docker-compose for the local
  dev stack; without it, spans are silently dropped (no collector at localhost).
