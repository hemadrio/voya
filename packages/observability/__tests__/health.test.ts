/**
 * Unit tests for health.ts — the dependency-aware health check builder.
 *
 * Tests run fully offline: no real DB, Redis, or queue required.
 * All timing is deterministic because probes are injected fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from 'node:http';
import {
  createHealthCheck,
  createSecretsProbe,
  _resetHealthCache,
} from '../src/health';
import type { Probe, HealthHandlers, ReadyBody, LiveBody } from '../src/health';

// ---------------------------------------------------------------------------
// Fake probe fixtures (AC11: committed fake probes for offline testing)
// ---------------------------------------------------------------------------

/** Always passes immediately. */
function makePassProbe(name: string, required = true): Probe {
  return {
    name,
    required,
    check: vi.fn(async () => true),
    timeoutMs: 500,
    cacheTtlMs: 0, // disable cache — most tests want fresh probe calls
  };
}

/** Always fails immediately (returns false). */
function makeFailProbe(name: string, required = true): Probe {
  return {
    name,
    required,
    check: vi.fn(async () => false),
    timeoutMs: 500,
    cacheTtlMs: 0,
  };
}

/** Takes longer than its own timeoutMs before resolving. */
function makeSlowProbe(name: string, required = true, timeoutMs = 40): Probe {
  return {
    name,
    required,
    // The check waits 10× the probe timeout — guaranteed to be killed by the
    // per-probe timer before it resolves.
    check: vi.fn(
      () =>
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), timeoutMs * 10),
        ),
    ),
    timeoutMs,
    cacheTtlMs: 0,
  };
}

/** Throws synchronously inside check(). */
function makeThrowingProbe(name: string, required = true): Probe {
  return {
    name,
    required,
    check: vi.fn(() => {
      throw new Error('BOOM — must be caught by framework');
    }),
    timeoutMs: 500,
    cacheTtlMs: 0,
  };
}

/** Rejects asynchronously inside check(). */
function makeRejectingProbe(name: string, required = true): Probe {
  return {
    name,
    required,
    check: vi.fn(async () => {
      throw new Error('async BOOM — must be caught by framework');
    }),
    timeoutMs: 500,
    cacheTtlMs: 0,
  };
}

// ---------------------------------------------------------------------------
// HTTP test helper — invokes a handler through a real (loopback) HTTP server
// so we get the real HTTP status code and JSON body without Express.
// ---------------------------------------------------------------------------

function invokeHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const req = http.get(`http://127.0.0.1:${addr.port}/`, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown });
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetHealthCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetHealthCache();
});

// ---------------------------------------------------------------------------
// /health/live
// ---------------------------------------------------------------------------

describe('/health/live', () => {
  it('returns 200 with status:alive and uptimeSeconds', async () => {
    const handlers: HealthHandlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [],
    });

    const result = await invokeHandler((req, res) => handlers.liveHandler(req, res));
    expect(result.status).toBe(200);
    const body = result.body as LiveBody;
    expect(body.status).toBe('alive');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('does NOT invoke any probe', async () => {
    const probe = makePassProbe('postgres');
    const handlers = createHealthCheck({ serviceName: 'test-svc', probes: [probe] });

    await invokeHandler((req, res) => handlers.liveHandler(req, res));

    expect(probe.check).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /health/ready — all probes pass → 200 healthy
// ---------------------------------------------------------------------------

describe('/health/ready — all probes pass', () => {
  it('returns 200 with status:healthy', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres'), makePassProbe('redis', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(200);
    const body = result.body as ReadyBody;
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('test-svc');
    expect(body.dependencies).toHaveLength(2);
    expect(body.dependencies.every((d) => d.status === 'pass')).toBe(true);
  });

  it('includes latencyMs for each dependency', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres')],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    expect(typeof body.dependencies[0]?.latencyMs).toBe('number');
    expect((body.dependencies[0]?.latencyMs ?? -1)).toBeGreaterThanOrEqual(0);
  });

  it('includes durationMs total', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres')],
    });
    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    expect(typeof body.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// /health/ready — required probe failure → 503 unhealthy
// ---------------------------------------------------------------------------

describe('/health/ready — required probe fails', () => {
  it('returns 503 with status:unhealthy', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeFailProbe('postgres', true)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(503);
    const body = result.body as ReadyBody;
    expect(body.status).toBe('unhealthy');
  });

  it('names the failing dependency in the response', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('redis', false), makeFailProbe('postgres', true)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    const failing = body.dependencies.find((d) => d.name === 'postgres');
    expect(failing?.status).toBe('fail');
    const passing = body.dependencies.find((d) => d.name === 'redis');
    expect(passing?.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// /health/ready — non-required probe fails → 200 degraded
// ---------------------------------------------------------------------------

describe('/health/ready — non-required probe failure (degraded)', () => {
  it('returns 200 with status:degraded', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres', true), makeFailProbe('redis', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(200);
    const body = result.body as ReadyBody;
    expect(body.status).toBe('degraded');
  });

  it('marks required as pass and non-required as fail', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres', true), makeFailProbe('queue', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    expect(body.dependencies.find((d) => d.name === 'postgres')?.status).toBe('pass');
    expect(body.dependencies.find((d) => d.name === 'queue')?.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// /health/ready — probe exceeds its timeout → fail with reason:timeout
// ---------------------------------------------------------------------------

describe('/health/ready — probe timeout', () => {
  it('reports fail with reason:timeout and resolves quickly', async () => {
    const slow = makeSlowProbe('slow-db', false, 40);
    const handlers = createHealthCheck({ serviceName: 'test-svc', probes: [slow] });

    const start = Date.now();
    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const elapsed = Date.now() - start;

    const body = result.body as ReadyBody;
    const dep = body.dependencies.find((d) => d.name === 'slow-db');
    expect(dep?.status).toBe('fail');
    expect(dep?.reason).toBe('timeout');
    // Total wall-clock should be well under 1 second (the probe timeout is 40 ms).
    expect(elapsed).toBeLessThan(800);
  });
});

// ---------------------------------------------------------------------------
// /health/ready — probe throws / rejects → fail (never 500)
// ---------------------------------------------------------------------------

describe('/health/ready — probe throws', () => {
  it('catches synchronous throws and returns fail (not 500)', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeThrowingProbe('explosive', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(200); // non-required → degraded, not 503
    const body = result.body as ReadyBody;
    expect(body.dependencies[0]?.status).toBe('fail');
    expect(body.dependencies[0]?.reason).toBe('probe failed');
  });

  it('catches async rejections and returns fail', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeRejectingProbe('async-explosive', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    expect(body.dependencies[0]?.status).toBe('fail');
    expect(body.dependencies[0]?.reason).toBe('probe failed');
  });

  it('required probe that throws returns 503 unhealthy', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeThrowingProbe('critical-db', true)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(503);
    const body = result.body as ReadyBody;
    expect(body.status).toBe('unhealthy');
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour (AC4)
// ---------------------------------------------------------------------------

describe('cache — N sequential calls inside TTL trigger exactly one check', () => {
  it('calls check exactly once for 5 sequential calls inside TTL', async () => {
    const checkFn = vi.fn(async () => true);
    const probe: Probe = {
      name: 'cached-db',
      required: true,
      check: checkFn,
      timeoutMs: 500,
      cacheTtlMs: 30_000, // 30 s — all calls within this test are cache hits
    };

    const handlers = createHealthCheck({ serviceName: 'test-svc', probes: [probe] });

    for (let i = 0; i < 5; i++) {
      await invokeHandler((req, res) => handlers.readyHandler(req, res));
    }

    expect(checkFn).toHaveBeenCalledTimes(1);
  });

  it('invokes check again after TTL expiry', async () => {
    const checkFn = vi.fn(async () => true);
    const probe: Probe = {
      name: 'short-ttl-db',
      required: true,
      check: checkFn,
      timeoutMs: 500,
      cacheTtlMs: 1, // 1 ms — expires nearly immediately
    };

    const handlers = createHealthCheck({ serviceName: 'test-svc', probes: [probe] });

    // First call — populates cache.
    await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(checkFn).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Second call — cache expired, should re-invoke.
    await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(checkFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createSecretsProbe (AC5)
// ---------------------------------------------------------------------------

describe('createSecretsProbe', () => {
  it('check() returns true when isValid=true', async () => {
    const probe = createSecretsProbe(true);
    const result = await probe.check();
    expect(result).toBe(true);
  });

  it('check() returns false when isValid=false', async () => {
    const probe = createSecretsProbe(false);
    const result = await probe.check();
    expect(result).toBe(false);
  });

  it('is required — false probe yields 503 unhealthy', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [createSecretsProbe(false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    expect(result.status).toBe(503);
    const body = result.body as ReadyBody;
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.find((d) => d.name === 'secrets')?.status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Security — response body must not expose credentials (AC3 / Constraints)
// ---------------------------------------------------------------------------

describe('response body security', () => {
  it('passing probe has no reason field', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makePassProbe('postgres')],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    expect(body.dependencies[0]?.reason).toBeUndefined();
  });

  it('failing probe reason is a short safe string (not a raw driver error)', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeFailProbe('postgres', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const body = result.body as ReadyBody;
    const reason = body.dependencies[0]?.reason;
    expect(['timeout', 'probe failed', 'internal error']).toContain(reason);
  });

  it('response never contains connection-string-like content', async () => {
    const handlers = createHealthCheck({
      serviceName: 'test-svc',
      probes: [makeFailProbe('postgres', false)],
    });

    const result = await invokeHandler((req, res) => handlers.readyHandler(req, res));
    const bodyStr = JSON.stringify(result.body);
    expect(bodyStr).not.toMatch(/password|credentials|:\/\//i);
  });
});
