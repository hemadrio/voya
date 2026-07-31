/**
 * OpenTelemetry tracing bootstrap for @travel services.
 *
 * Call initTracing() as the very first import in every service entrypoint so
 * auto-instrumentation can patch Express, Prisma, Redis, HTTP, amqplib and
 * the AWS SDK before those modules are loaded.
 *
 * On OTLP exporter failure the SDK degrades silently — spans are dropped,
 * nothing is thrown into the request path, and WO-007's correlation-ID-based
 * error reference remains populated via the fallback in getTraceId().
 *
 * Sampling policy (ADR 0002):
 *   - Head: ParentBased(TraceIdRatioBased(0.1)) — 10% of root traces sampled.
 *   - AlwaysRecord: unsampled traces return RECORD_ONLY so spans are created
 *     and can be inspected by the ErrorAndSlowSpanProcessor below.
 *   - Tail override: ErrorAndSlowSpanProcessor exports any RECORD_ONLY span
 *     that has ERROR status or duration > latencyBudgetMs regardless of the
 *     head decision, satisfying the "always export error/slow traces" policy.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_CLOUD_PLATFORM,
} from '@opentelemetry/semantic-conventions';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
  ParentBasedSampler,
  TraceIdRatioBased,
  hrTimeToMilliseconds,
} from '@opentelemetry/core';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type {
  ReadableSpan,
  SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  SamplingDecision,
  SpanStatusCode,
  TraceFlags,
  propagation,
} from '@opentelemetry/api';
import type {
  Context,
  Sampler,
  SamplingResult,
  Link,
  Attributes,
  SpanKind,
} from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Journey latency budgets (ms p95) from the platform specification.
// Spans exceeding this threshold are always exported even if not head-sampled.
// ---------------------------------------------------------------------------
const DEFAULT_LATENCY_BUDGET_MS = 3_000; // search cache-miss p95

// ---------------------------------------------------------------------------
// AlwaysRecordSampler
//
// Wraps ParentBased(TraceIdRatioBased(ratio)) but downgrades NOT_RECORD to
// RECORD_ONLY so all spans are created in memory.  The ErrorAndSlowSpanProcessor
// then decides at span-end time whether to export based on error / slow status.
// This enables the "tail-style" always-export-on-error policy without a true
// tail-sampling buffer.
// ---------------------------------------------------------------------------
export class AlwaysRecordSampler implements Sampler {
  private readonly delegate: Sampler;
  private readonly ratio: number;

  constructor(ratio: number) {
    this.ratio = ratio;
    this.delegate = new ParentBasedSampler({ root: new TraceIdRatioBased(ratio) });
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const result = this.delegate.shouldSample(
      context, traceId, spanName, spanKind, attributes, links,
    );
    if (result.decision === SamplingDecision.NOT_RECORD) {
      // Downgrade: create span but do not export by default.
      return { decision: SamplingDecision.RECORD_ONLY };
    }
    return result;
  }

  toString(): string {
    return `AlwaysRecord(ParentBased(TraceIdRatio(${this.ratio})))`;
  }
}

// ---------------------------------------------------------------------------
// ErrorAndSlowSpanProcessor
//
// Exports RECORD_ONLY spans that have ERROR status or exceed the latency
// budget.  Sampled (RECORD_AND_SAMPLED) spans go through BatchSpanProcessor
// normally; this processor only handles the 90% of un-sampled spans to
// promote those that need guaranteed export.
// ---------------------------------------------------------------------------
export class ErrorAndSlowSpanProcessor {
  private readonly exporter: SpanExporter;
  private readonly budgetMs: number;

  constructor(exporter: SpanExporter, latencyBudgetMs: number = DEFAULT_LATENCY_BUDGET_MS) {
    this.exporter = exporter;
    this.budgetMs = latencyBudgetMs;
  }

  onStart(_span: unknown, _parentContext: unknown): void {
    // Assessment happens at span end.
  }

  onEnd(span: ReadableSpan): void {
    // Only handle RECORD_ONLY spans; sampled spans go through BatchSpanProcessor.
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0) return;

    const isError = span.status.code === SpanStatusCode.ERROR;
    const durationMs = hrTimeToMilliseconds(span.duration);
    const isSlow = durationMs > this.budgetMs;

    if (isError || isSlow) {
      // Fire-and-forget: export failures are silenced via OTel diag logger.
      this.exporter.export([span], () => { /* result ignored */ });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface TracingOptions {
  /** Service name — must match the CloudWatch log group and ECS service name. */
  readonly serviceName: string;
  /** Service version from SERVICE_VERSION env var or package.json. */
  readonly serviceVersion?: string | undefined;
  /** Deployment environment: 'production' | 'staging' | 'development'. */
  readonly deploymentEnvironment?: string | undefined;
  /** Head-sampling ratio for root spans 0.0–1.0 (default: 0.1 = 10%). */
  readonly sampleRatio?: number | undefined;
  /**
   * Latency budget in ms — spans exceeding this are always exported (default: 3000 ms,
   * the search p95 budget from the platform specification).
   */
  readonly latencyBudgetMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Module-level singleton — idempotent across multiple initTracing() calls.
// ---------------------------------------------------------------------------
let _sdk: NodeSDK | undefined;

// ---------------------------------------------------------------------------
// initTracing
// ---------------------------------------------------------------------------

/**
 * Bootstrap the OpenTelemetry NodeSDK.
 *
 * Must be invoked before any instrumented library (Express, Prisma, Redis,
 * amqplib, AWS SDK) is imported so the shimmer patches can take effect.
 *
 * On failure the function logs a descriptive error to stderr and returns
 * undefined — the service continues without tracing, and the correlation ID
 * from WO-007 still populates the error envelope reference.
 *
 * Returns the NodeSDK instance so callers can call shutdownTracing(sdk)
 * explicitly if needed; SIGTERM/SIGINT handlers are also registered
 * automatically.
 */
export function initTracing(options: TracingOptions): NodeSDK | undefined {
  if (_sdk !== undefined) return _sdk;

  const {
    serviceName,
    serviceVersion = process.env['SERVICE_VERSION'] ?? '0.0.0',
    deploymentEnvironment = process.env['NODE_ENV'] ?? 'development',
    sampleRatio = 0.1,
    latencyBudgetMs = DEFAULT_LATENCY_BUDGET_MS,
  } = options;

  try {
    const resource = new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: deploymentEnvironment,
      // aws_ecs matches the ECS Fargate compute platform for this service fleet.
      [SEMRESATTRS_CLOUD_PLATFORM]: 'aws_ecs',
    });

    // OTLP over HTTP to the ADOT sidecar in the same ECS task network namespace.
    // The default port 4318 is the OTLP/HTTP endpoint; 4317 is gRPC.
    const otlpBase = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318';
    const exporter = new OTLPTraceExporter({
      url: `${otlpBase}/v1/traces`,
      // timeoutMillis and concurrencyLimit are left at SDK defaults.
      // The BatchSpanProcessor already provides internal buffering.
    });

    // CompositePropagator: X-Ray first (native AWS) then W3C traceparent (OTel
    // inter-service) then W3C baggage (for correlation-id propagation from WO-007).
    const compositePropagator = new CompositePropagator({
      propagators: [
        new AWSXRayPropagator(),
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    });

    // Register globally so injectHeaders() / propagation.inject() in WO-007
    // correlation.ts produces X-Ray and W3C headers automatically.
    propagation.setGlobalPropagator(compositePropagator);

    const sampler = new AlwaysRecordSampler(sampleRatio);

    const errorAndSlowProcessor = new ErrorAndSlowSpanProcessor(exporter, latencyBudgetMs);

    const sdkConfig: NodeSDKConfiguration = {
      resource,
      idGenerator: new AWSXRayIdGenerator(),
      sampler,
      spanProcessors: [
        // Batch processor for normally-sampled spans
        new BatchSpanProcessor(exporter),
        // Override processor for error / slow un-sampled spans
        errorAndSlowProcessor as unknown as InstanceType<typeof BatchSpanProcessor>,
      ],
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable filesystem instrumentation: avoids span noise from Node.js
          // internal file reads and keeps span volume within the $240/month budget.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          // Exclude ALB health-check probes from tracing to avoid flooding X-Ray.
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (req: { url?: string }) => {
              const url = req.url ?? '';
              return url === '/health' || url === '/health/live' || url === '/health/ready';
            },
          },
        }),
      ],
      textMapPropagator: compositePropagator,
    };

    _sdk = new NodeSDK(sdkConfig);
    // start() registers instrumentations synchronously; async resource detection
    // runs in the background.  Both behaviours are intentional here.
    _sdk.start();

    const shutdownHandler = (): void => {
      void shutdownTracing(_sdk);
    };
    process.once('SIGTERM', shutdownHandler);
    process.once('SIGINT', shutdownHandler);

    return _sdk;
  } catch (err) {
    // Never throw — the service must start even if tracing fails.
    console.error(
      '[tracing] Failed to initialise OpenTelemetry SDK — continuing without tracing:',
      err,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// shutdownTracing
// ---------------------------------------------------------------------------

const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Flush pending spans and shut down the SDK.
 *
 * Called automatically by the SIGTERM/SIGINT handlers registered in
 * initTracing().  If the flush does not complete within timeoutMs, a warning
 * is logged and the process is allowed to exit — no spans are worth blocking
 * a graceful ECS task stop.
 */
export async function shutdownTracing(
  sdk?: NodeSDK | undefined,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const target = sdk ?? _sdk;
  if (target === undefined) return;

  try {
    const flushTimeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tracing shutdown timed out after ${timeoutMs} ms — some spans may be lost`));
      }, timeoutMs);
      // Ensure this timer does not prevent process exit.
      if (typeof (timer as NodeJS.Timeout).unref === 'function') {
        (timer as NodeJS.Timeout).unref();
      }
    });

    await Promise.race([target.shutdown(), flushTimeout]);
  } catch (err) {
    // A timeout or flush error must not block exit.
    console.warn('[tracing] Shutdown flush incomplete:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Test helper — reset the singleton between tests.
// Exported only for test use; not part of the public package surface.
// ---------------------------------------------------------------------------
export function _resetTracingSingleton(): void {
  _sdk = undefined;
}
