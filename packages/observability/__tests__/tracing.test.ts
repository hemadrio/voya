/**
 * Unit tests for packages/observability/src/tracing.ts and spanAttributes.ts
 *
 * Tests run without any AWS or external supplier dependency using:
 *   - InMemorySpanExporter (captures spans in memory)
 *   - BasicTracerProvider (lightweight OTel SDK for tests)
 *   - Composite propagator under direct inject/extract assertions
 *
 * AC1:  initTracing constructs NodeSDK with X-Ray ID generator and propagator.
 * AC4:  AlwaysRecordSampler + ErrorAndSlowSpanProcessor sampling policy.
 * AC6:  Span attribute helpers (supplier, booking, assistant budget).
 * AC9:  Unit tests passing for propagator, sampler, resource, span attributes.
 */

import {
  AlwaysRecordSampler,
  ErrorAndSlowSpanProcessor,
  initTracing,
  shutdownTracing,
  _resetTracingSingleton,
  recordSupplierCall,
  recordBookingTransition,
  recordAssistantBudget,
} from '../src/index.js';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  SamplingDecision,
  SpanStatusCode,
  TraceFlags,
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from '@opentelemetry/core';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { W3CTraceContextPropagator as W3cCtx } from '@opentelemetry/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an InMemorySpanExporter wired into a BasicTracerProvider. */
function makeTestProvider(): {
  provider: BasicTracerProvider;
  exporter: InMemorySpanExporter;
  finishedSpans: () => ReadableSpan[];
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  return {
    provider,
    exporter,
    finishedSpans: () => exporter.getFinishedSpans(),
  };
}

// ---------------------------------------------------------------------------
// AlwaysRecordSampler
// ---------------------------------------------------------------------------

describe('AlwaysRecordSampler', () => {
  it('returns RECORD_AND_SAMPLED for trace IDs that pass the ratio', () => {
    // TraceIdRatioBased with ratio=1.0 always samples
    const sampler = new AlwaysRecordSampler(1.0);
    const ctx = otelContext.active();
    const result = sampler.shouldSample(ctx, 'aaaa'.repeat(8), 'test', 0, {}, []);
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  it('returns RECORD_ONLY instead of NOT_RECORD for ratio=0.0', () => {
    // TraceIdRatioBased with ratio=0.0 never samples — sampler must downgrade
    // NOT_RECORD to RECORD_ONLY so spans are still created.
    const sampler = new AlwaysRecordSampler(0.0);
    const ctx = otelContext.active();
    const result = sampler.shouldSample(ctx, 'bbbb'.repeat(8), 'test', 0, {}, []);
    expect(result.decision).toBe(SamplingDecision.RECORD_ONLY);
  });

  it('never returns NOT_RECORD', () => {
    const sampler = new AlwaysRecordSampler(0.1);
    const ctx = otelContext.active();
    // Run 50 random-ish trace IDs and assert none returns NOT_RECORD
    for (let i = 0; i < 50; i++) {
      const traceId = i.toString(16).padStart(32, '0');
      const result = sampler.shouldSample(ctx, traceId, 'test', 0, {}, []);
      expect(result.decision).not.toBe(SamplingDecision.NOT_RECORD);
    }
  });

  it('toString returns a descriptive string', () => {
    const sampler = new AlwaysRecordSampler(0.1);
    expect(sampler.toString()).toContain('AlwaysRecord');
    expect(sampler.toString()).toContain('0.1');
  });
});

// ---------------------------------------------------------------------------
// ErrorAndSlowSpanProcessor
// ---------------------------------------------------------------------------

describe('ErrorAndSlowSpanProcessor', () => {
  function makeRecordOnlySpan(status: { code: SpanStatusCode }, durationMs: number): ReadableSpan {
    const nsPerMs = 1_000_000;
    const durationNs = durationMs * nsPerMs;
    return {
      spanContext: () => ({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.NONE, // RECORD_ONLY — not sampled
        isRemote: false,
      }),
      status,
      duration: [Math.floor(durationNs / 1e9), durationNs % 1e9] as [number, number],
      name: 'test-span',
      kind: 0,
      startTime: [0, 0] as [number, number],
      endTime: [0, durationNs] as [number, number],
      attributes: {},
      links: [],
      events: [],
      resource: {} as never,
      instrumentationLibrary: { name: 'test' },
      parentSpanId: undefined,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    } as unknown as ReadableSpan;
  }

  function makeSampledSpan(status: { code: SpanStatusCode }, durationMs: number): ReadableSpan {
    const span = makeRecordOnlySpan(status, durationMs);
    (span.spanContext as unknown as () => { traceFlags: number }) = () => ({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: TraceFlags.SAMPLED, // sampled — should be ignored by this processor
      isRemote: false,
    });
    return span;
  }

  it('exports RECORD_ONLY ERROR spans', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    const span = makeRecordOnlySpan({ code: SpanStatusCode.ERROR }, 100);
    processor.onEnd(span);
    expect(exporter.getFinishedSpans().length).toBe(1);
  });

  it('exports RECORD_ONLY spans exceeding the latency budget', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    const span = makeRecordOnlySpan({ code: SpanStatusCode.OK }, 4000); // exceeds 3000ms
    processor.onEnd(span);
    expect(exporter.getFinishedSpans().length).toBe(1);
  });

  it('does NOT export normal RECORD_ONLY spans (no error, under budget)', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    const span = makeRecordOnlySpan({ code: SpanStatusCode.OK }, 100);
    processor.onEnd(span);
    expect(exporter.getFinishedSpans().length).toBe(0);
  });

  it('does NOT export SAMPLED spans (those go through BatchSpanProcessor)', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    const span = makeSampledSpan({ code: SpanStatusCode.ERROR }, 100);
    processor.onEnd(span);
    expect(exporter.getFinishedSpans().length).toBe(0);
  });

  it('exports at the exact budget boundary (strictly greater than)', () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    const atBudget = makeRecordOnlySpan({ code: SpanStatusCode.OK }, 3000);
    processor.onEnd(atBudget); // exactly at budget — should NOT export
    expect(exporter.getFinishedSpans().length).toBe(0);

    exporter.reset();
    const overBudget = makeRecordOnlySpan({ code: SpanStatusCode.OK }, 3001);
    processor.onEnd(overBudget); // over budget — should export
    expect(exporter.getFinishedSpans().length).toBe(1);
  });

  it('shutdown() and forceFlush() resolve without error', async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new ErrorAndSlowSpanProcessor(exporter, 3000);
    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composite propagator inject/extract
// ---------------------------------------------------------------------------

describe('Composite propagator — inject and extract', () => {
  const compositeProps = new CompositePropagator({
    propagators: [
      new AWSXRayPropagator(),
      new W3CTraceContextPropagator(),
      new W3CBaggagePropagator(),
    ],
  });

  it('injects W3C traceparent header', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('root');
    const ctx = trace.setSpan(otelContext.active(), span);
    const carrier: Record<string, string> = {};
    compositeProps.inject(ctx, carrier, {
      set: (c, k, v) => { (c as Record<string, string>)[k] = v; },
    });
    span.end();
    expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    exporter.reset();
    provider.shutdown();
  });

  it('injects X-Ray X-Amzn-Trace-Id header', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('root');
    const ctx = trace.setSpan(otelContext.active(), span);
    const carrier: Record<string, string> = {};
    compositeProps.inject(ctx, carrier, {
      set: (c, k, v) => { (c as Record<string, string>)[k] = v; },
    });
    span.end();
    expect(carrier['X-Amzn-Trace-Id']).toBeDefined();
    exporter.reset();
    provider.shutdown();
  });

  it('extracts W3C traceparent to restore span context', () => {
    const carrier: Record<string, string> = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    };
    const extractedCtx = compositeProps.extract(otelContext.active(), carrier, {
      get: (c, k) => (c as Record<string, string>)[k],
      keys: (c) => Object.keys(c as Record<string, string>),
    });
    const span = trace.getSpan(extractedCtx);
    expect(span).toBeDefined();
    expect(span?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('extracts X-Ray X-Amzn-Trace-Id to restore span context', () => {
    const carrier: Record<string, string> = {
      'X-Amzn-Trace-Id': 'Root=1-5759e988-bd862e3fe1be46a994272793;Sampled=1',
    };
    const extractedCtx = compositeProps.extract(otelContext.active(), carrier, {
      get: (c, k) => (c as Record<string, string>)[k],
      keys: (c) => Object.keys(c as Record<string, string>),
    });
    const span = trace.getSpan(extractedCtx);
    expect(span).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Resource attribute construction
// ---------------------------------------------------------------------------

describe('Resource attributes', () => {
  it('initTracing constructs NodeSDK (smoke test — does not throw)', () => {
    _resetTracingSingleton();
    // In unit test environment the OTLP exporter will fail to connect (no sidecar)
    // but initTracing must not throw — it must degrade gracefully.
    expect(() => {
      initTracing({
        serviceName: 'test-service',
        serviceVersion: '1.2.3',
        deploymentEnvironment: 'test',
        sampleRatio: 0.1,
      });
    }).not.toThrow();
    _resetTracingSingleton();
  });

  it('initTracing is idempotent — second call returns the same SDK', () => {
    _resetTracingSingleton();
    const sdk1 = initTracing({ serviceName: 'idempotent-test' });
    const sdk2 = initTracing({ serviceName: 'idempotent-test' });
    expect(sdk1).toBe(sdk2);
    _resetTracingSingleton();
  });
});

// ---------------------------------------------------------------------------
// shutdownTracing
// ---------------------------------------------------------------------------

describe('shutdownTracing', () => {
  it('resolves without error when no SDK has been initialised', async () => {
    _resetTracingSingleton();
    await expect(shutdownTracing(undefined)).resolves.toBeUndefined();
  });

  it('resolves without error when sdk is provided', async () => {
    _resetTracingSingleton();
    const sdk = initTracing({ serviceName: 'shutdown-test' });
    await expect(shutdownTracing(sdk)).resolves.toBeUndefined();
    _resetTracingSingleton();
  });
});

// ---------------------------------------------------------------------------
// recordSupplierCall
// ---------------------------------------------------------------------------

describe('recordSupplierCall', () => {
  it('sets supplier attributes on the active span', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('search');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordSupplierCall('amadeus', 'success', 350);
    });
    span.end();
    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThan(0);
    const attrs = finished[0]?.attributes ?? {};
    expect(attrs['travel.supplier.name']).toBe('amadeus');
    expect(attrs['travel.supplier.outcome']).toBe('success');
    expect(attrs['travel.supplier.duration_ms']).toBe(350);
    provider.shutdown();
  });

  it('sets ERROR status for timeout outcome', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('search');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordSupplierCall('amadeus', 'timeout', 2200);
    });
    span.end();
    const finished = exporter.getFinishedSpans();
    expect(finished[0]?.status.code).toBe(SpanStatusCode.ERROR);
    provider.shutdown();
  });

  it('does not throw when no span is active', () => {
    expect(() => recordSupplierCall('amadeus', 'success', 100)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordBookingTransition
// ---------------------------------------------------------------------------

describe('recordBookingTransition', () => {
  it('sets booking transition attributes on the active span', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('checkout');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordBookingTransition('b1a2c3d4-uuid', 'PENDING', 'CONFIRMED');
    });
    span.end();
    const finished = exporter.getFinishedSpans();
    const attrs = finished[0]?.attributes ?? {};
    expect(attrs['travel.booking.id']).toBe('b1a2c3d4-uuid');
    expect(attrs['travel.booking.from_state']).toBe('PENDING');
    expect(attrs['travel.booking.to_state']).toBe('CONFIRMED');
    provider.shutdown();
  });

  it('does not throw when no span is active', () => {
    expect(() => recordBookingTransition('uuid', 'PENDING', 'CONFIRMED')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordAssistantBudget
// ---------------------------------------------------------------------------

describe('recordAssistantBudget', () => {
  it('sets remaining token/tool-call attributes on the active span', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('conversation');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordAssistantBudget(1500, 8);
    });
    span.end();
    const finished = exporter.getFinishedSpans();
    const attrs = finished[0]?.attributes ?? {};
    expect(attrs['travel.ai.remaining_tokens']).toBe(1500);
    expect(attrs['travel.ai.remaining_tool_calls']).toBe(8);
    expect(attrs['travel.ai.budget_cap_hit']).toBeUndefined();
    provider.shutdown();
  });

  it('sets budget_cap_hit=true when tokens exhausted', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('conversation');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordAssistantBudget(0, 5);
    });
    span.end();
    const attrs = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attrs['travel.ai.budget_cap_hit']).toBe(true);
    provider.shutdown();
  });

  it('sets budget_cap_hit=true when tool calls exhausted', () => {
    const { provider, exporter } = makeTestProvider();
    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('conversation');
    const ctx = trace.setSpan(otelContext.active(), span);
    otelContext.with(ctx, () => {
      recordAssistantBudget(500, 0);
    });
    span.end();
    const attrs = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attrs['travel.ai.budget_cap_hit']).toBe(true);
    provider.shutdown();
  });

  it('does not throw when no span is active', () => {
    expect(() => recordAssistantBudget(500, 5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Startup ordering lint check
// ---------------------------------------------------------------------------

describe('Startup ordering', () => {
  it('tracing.ts imports are purely from @travel/observability with no app modules', () => {
    // Verify that the service tracing.ts files do not import application modules.
    // This test reads the actual tracing.ts files and asserts that the only
    // non-Node import is @travel/observability.
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.resolve(__dirname, '../../../../');
    const serviceDirs = [
      'services/auth-service/src/tracing.ts',
      'services/booking-service/src/tracing.ts',
      'services/payment-service/src/tracing.ts',
      'services/search-service/src/tracing.ts',
      'services/user-service/src/tracing.ts',
      'services/ai-service/src/tracing.ts',
      'services/itinerary-service/src/tracing.ts',
      'services/reporting-service/src/tracing.ts',
      'services/notification-service/src/tracing.ts',
    ];

    for (const rel of serviceDirs) {
      const tracingPath = path.join(repoRoot, rel);
      const content: string = fs.readFileSync(tracingPath, 'utf8');
      // Only allowed imports: @travel/observability and node: protocol
      const importLines = content.split('\n').filter((l: string) => l.startsWith('import'));
      for (const line of importLines) {
        const isObs = line.includes('@travel/observability');
        const isNode = line.includes('node:');
        expect(isObs || isNode).toBe(true);
      }
    }
  });
});
