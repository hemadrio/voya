/**
 * Dependency-aware deep health check builder for @travel services.
 *
 * Exports:
 *   createHealthCheck(config)  — returns Express-compatible handlers for
 *                                /health/live and /health/ready.
 *   createPrismaProbe()        — PostgreSQL liveness via $queryRaw.
 *   createRedisProbe()         — Redis PING, handles ioredis v4/v5.
 *   createQueueProbe()         — Queue connectivity via QueuePort.isHealthy().
 *   createSecretsProbe()       — Reads cached result of startup validator.
 *
 * Design invariants:
 *   - Probes execute in parallel via Promise.allSettled.
 *   - Each probe has an individual timeout (default 1 000 ms).
 *   - Results are cached per probe name for cacheTtlMs (default 5 000 ms) so
 *     repeated ALB probes do not exhaust the Prisma connection_limit of 5.
 *   - Health responses never include credentials, connection strings, or raw
 *     driver error messages.
 *   - /health/live never touches dependencies; completes well under 50 ms.
 *   - Required-probe failures → 503 unhealthy; non-required failures → 200 degraded.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single dependency probe.
 */
export interface Probe {
  /** Unique dependency name shown in the response body. */
  readonly name: string;
  /** Async or sync check function — resolves/returns true on pass, false on fail. */
  readonly check: () => Promise<boolean> | boolean;
  /** When true a failing probe causes 503 unhealthy; false → 200 degraded. */
  readonly required: boolean;
  /** Per-probe wall-clock timeout in ms (default 1 000). */
  readonly timeoutMs?: number | undefined;
  /** How long to cache the last result in ms (default 5 000). */
  readonly cacheTtlMs?: number | undefined;
}

export type ProbeStatus = 'pass' | 'warn' | 'fail';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ProbeResult {
  readonly name: string;
  readonly status: ProbeStatus;
  readonly latencyMs: number;
  readonly reason?: string | undefined;
}

export interface ReadyBody {
  readonly service: string;
  readonly status: HealthStatus;
  readonly durationMs: number;
  readonly dependencies: ReadonlyArray<ProbeResult>;
}

export interface LiveBody {
  readonly status: 'alive';
  readonly uptimeSeconds: number;
}

/** Express-compatible (and raw-http-compatible) handler pair. */
export interface HealthHandlers {
  liveHandler(req: IncomingMessage, res: ServerResponse): void;
  readyHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface HealthCheckConfig {
  /** Service name — included in the /health/ready response body. */
  readonly serviceName: string;
  readonly probes: ReadonlyArray<Probe>;
}

// ---------------------------------------------------------------------------
// In-memory result cache (per probe name)
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly result: ProbeResult;
  readonly expiresAt: number;
}

const probeResultCache = new Map<string, CacheEntry>();

/** Flush all cached probe results — used between unit tests. */
export function _resetHealthCache(): void {
  probeResultCache.clear();
}

// ---------------------------------------------------------------------------
// Per-probe timeout wrapper
// ---------------------------------------------------------------------------

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

async function runWithTimeout(probe: Probe): Promise<ProbeResult> {
  const timeoutMs = probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const start = Date.now();

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      // Allow process to exit without waiting on this timer.
      if (typeof timer.unref === 'function') timer.unref();
    });

    const passed = await Promise.race([
      Promise.resolve().then(() => probe.check()),
      timeoutGuard,
    ]);

    return {
      name: probe.name,
      status: passed ? 'pass' : 'fail',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.message === 'timeout'
        ? 'timeout'
        : 'probe failed';
    return {
      name: probe.name,
      status: 'fail',
      latencyMs: Date.now() - start,
      reason,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cached probe runner
// ---------------------------------------------------------------------------

async function runProbe(probe: Probe): Promise<ProbeResult> {
  const now = Date.now();
  const cached = probeResultCache.get(probe.name);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await runWithTimeout(probe);
  const ttl = probe.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  probeResultCache.set(probe.name, { result, expiresAt: now + ttl });
  return result;
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: LiveBody | ReadyBody,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Prevent ALB / CDN from caching health responses.
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// createHealthCheck
// ---------------------------------------------------------------------------

/**
 * Build Express-compatible handlers for /health/live and /health/ready.
 *
 * The returned handlers are typed against node:http's IncomingMessage and
 * ServerResponse so they work directly with Express (whose Response extends
 * ServerResponse) as well as with the raw http.createServer() used by the
 * notification consumer's health-check port.
 */
export function createHealthCheck(config: HealthCheckConfig): HealthHandlers {
  const { serviceName, probes } = config;

  function liveHandler(_req: IncomingMessage, res: ServerResponse): void {
    const body: LiveBody = {
      status: 'alive',
      uptimeSeconds: Math.floor(process.uptime()),
    };
    writeJson(res, 200, body);
  }

  async function readyHandler(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const start = Date.now();

    // Run all probes in parallel; allSettled so a throwing probe doesn't abort
    // the rest. The per-probe runWithTimeout wrapper already catches throws.
    const results = await Promise.allSettled(probes.map(runProbe));
    const probeResults: ProbeResult[] = results.map((settled, i) => {
      if (settled.status === 'fulfilled') return settled.value;
      // runProbe should never reject (runWithTimeout catches everything), but
      // be defensive.
      const name = probes[i]?.name ?? `probe-${i}`;
      return { name, status: 'fail' as ProbeStatus, latencyMs: 0, reason: 'internal error' };
    });

    // Determine overall status
    let overallStatus: HealthStatus = 'healthy';
    for (let i = 0; i < probeResults.length; i++) {
      const r = probeResults[i];
      const p = probes[i];
      if (r === undefined || p === undefined) continue;
      if (r.status === 'fail') {
        if (p.required) {
          overallStatus = 'unhealthy';
          break; // required failure is definitive
        } else if (overallStatus === 'healthy') {
          overallStatus = 'degraded';
        }
      }
    }

    const body: ReadyBody = {
      service: serviceName,
      status: overallStatus,
      durationMs: Date.now() - start,
      dependencies: probeResults,
    };

    const httpStatus = overallStatus === 'unhealthy' ? 503 : 200;
    writeJson(res, httpStatus, body);
  }

  return { liveHandler, readyHandler };
}

// ---------------------------------------------------------------------------
// Concrete probe factories
// ---------------------------------------------------------------------------

/**
 * Minimal PrismaClient interface — avoids importing @prisma/client in the
 * observability package.  Satisfies structurally by any PrismaClient instance.
 */
export interface PrismaHealthClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * Create a PostgreSQL liveness probe via a lightweight Prisma $queryRaw.
 *
 * The query is intentionally trivial (SELECT 1) to avoid any table scans.
 * Cache TTL default 5 s — at ALB interval of 10 s, each of 9 services issues
 * at most 2 actual DB queries per minute, well within the connection_limit=5.
 */
export function createPrismaProbe(
  client: PrismaHealthClient,
  opts?: { name?: string; timeoutMs?: number; cacheTtlMs?: number },
): Probe {
  return {
    name: opts?.name ?? 'postgres',
    required: true,
    timeoutMs: opts?.timeoutMs ?? 1_000,
    cacheTtlMs: opts?.cacheTtlMs ?? 5_000,
    check: async () => {
      // $queryRaw returns rows; we only care that it resolves without throwing.
      await (client.$queryRaw as (q: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
      return true;
    },
  };
}

/**
 * Minimal Redis interface — duck-typed to support both ioredis v4/v5 and the
 * redis npm package v4/v5 (all expose a PING-returning .ping() method).
 */
export interface RedisHealthClient {
  ping(): Promise<string>;
}

/**
 * Create a Redis liveness probe via PING.
 *
 * Non-required by default — a Redis outage on search-path services triggers
 * degraded-but-serving (consistent with the fallback to direct supplier calls
 * at a tightened 1 500 ms timeout) rather than 503 unhealthy, so a cache
 * outage never rolls back a healthy deployment.
 */
export function createRedisProbe(
  client: RedisHealthClient,
  opts?: {
    name?: string;
    required?: boolean;
    timeoutMs?: number;
    cacheTtlMs?: number;
  },
): Probe {
  return {
    name: opts?.name ?? 'redis',
    required: opts?.required ?? false,
    timeoutMs: opts?.timeoutMs ?? 500,
    cacheTtlMs: opts?.cacheTtlMs ?? 5_000,
    check: async () => {
      const reply = await client.ping();
      return reply.toUpperCase() === 'PONG';
    },
  };
}

/**
 * Minimal queue health interface — matches @travel/queue's QueuePort.isHealthy().
 */
export interface QueueHealthClient {
  isHealthy(): Promise<boolean>;
}

/**
 * Create a queue connectivity probe via QueuePort.isHealthy().
 *
 * Non-required by default — queue outage is degraded-but-serving for services
 * that can operate without publishing events (e.g. read-path services).
 */
export function createQueueProbe(
  client: QueueHealthClient,
  opts?: {
    name?: string;
    required?: boolean;
    timeoutMs?: number;
    cacheTtlMs?: number;
  },
): Probe {
  return {
    name: opts?.name ?? 'queue',
    required: opts?.required ?? false,
    timeoutMs: opts?.timeoutMs ?? 1_000,
    cacheTtlMs: opts?.cacheTtlMs ?? 5_000,
    check: () => client.isHealthy(),
  };
}

/**
 * Create a secrets-validation probe.
 *
 * The probe returns the static `isValid` value supplied at construction — it
 * never re-reads environment variables or prints secret values.  The caller
 * passes `true` only after validateSecrets() has already returned successfully
 * (validateSecrets exits the process on failure, so execution reaching this
 * call site implies validity).
 */
export function createSecretsProbe(isValid: boolean): Probe {
  return {
    name: 'secrets',
    required: true,
    timeoutMs: 50,
    cacheTtlMs: 60_000,
    check: () => isValid,
  };
}

/**
 * Create a secrets-validation probe that re-evaluates from process.env on
 * every call, so runtime secret rotation to an invalid state is reflected
 * in the next readiness check.
 *
 * Uses the formal SecretValidationResult from secretValidator rather than a
 * static boolean, so the probe correctly catches placeholder values that are
 * injected into the environment after the service has started.
 *
 * A short 10-second cache TTL is intentional: short enough to detect rotation
 * within one ALB probe interval (10 s), long enough to avoid hammering the
 * validation logic on every health probe at scale.
 *
 * Import note: dynamic import is used for secretValidator to avoid a circular
 * dependency between health.ts and secretValidator.ts at module load time.
 */
export interface SecretDescriptorLike {
  readonly envVar: string;
  readonly description: string;
  readonly minLength?: number | undefined;
  readonly allowEmptyInDev?: boolean | undefined;
}

export function createValidatorProbe(
  manifest: ReadonlyArray<SecretDescriptorLike>,
): Probe {
  return {
    name: 'secrets',
    required: true,
    timeoutMs: 100,
    cacheTtlMs: 10_000,
    check: async () => {
      // Dynamic import avoids circular module graph: health.ts ↔ secretValidator.ts
      const { validate } = await import('./secretValidator.js');
      const nodeEnv = process.env['NODE_ENV'] ?? '';
      const result = validate(
        manifest,
        process.env as Record<string, string | undefined>,
        { relaxed: nodeEnv === 'development' },
      );
      return result.ok;
    },
  };
}
