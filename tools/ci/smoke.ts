#!/usr/bin/env tsx
/**
 * smoke.ts — Post-deploy smoke test runner (WO-087).
 *
 * Hits /health/ready on every registered service endpoint and sends one
 * representative journey request per domain (flight search, hotel search,
 * car rental, booking creation). Fails the stage on any non-2xx response or
 * on the absence of required security headers.
 *
 * Required response headers (all responses):
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY | SAMEORIGIN
 *   Strict-Transport-Security: max-age=...
 *
 * Usage:
 *   tsx tools/ci/smoke.ts --config <path>
 *
 * Config file format (JSON):
 *   {
 *     "services": [
 *       { "name": "auth-service", "baseUrl": "https://auth.internal" },
 *       ...
 *     ],
 *     "journeys": [
 *       { "name": "flight_search", "service": "search-service",
 *         "method": "GET", "path": "/v1/search/flights?from=JFK&to=LAX&date=2030-06-01",
 *         "expectStatus": 200 },
 *       ...
 *     ]
 *   }
 *
 * Exit codes:
 *   0 — all health checks and journey requests passed
 *   1 — one or more checks failed
 *   2 — usage / I/O / config parse error
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceEndpoint {
  name: string;
  baseUrl: string;
}

export interface JourneyRequest {
  name: string;
  service: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** Expected HTTP status code (default: 200). */
  expectStatus?: number;
}

export interface SmokeConfig {
  services: ServiceEndpoint[];
  journeys: JourneyRequest[];
}

export interface SmokeCheckResult {
  name: string;
  url: string;
  passed: boolean;
  status?: number;
  durationMs?: number;
  error?: string;
  missingHeaders?: string[];
}

export interface HttpFetcher {
  fetch(
    url: string,
    opts: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
  ): Promise<{ status: number; headers: Map<string, string> }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** HTTP headers that every service response must include. */
export const REQUIRED_SECURITY_HEADERS: readonly string[] = [
  "x-content-type-options",
  "x-frame-options",
  "strict-transport-security",
];

/** Timeout per request in milliseconds. */
export const REQUEST_TIMEOUT_MS = 10_000;

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Parse and validate a smoke config JSON string.
 * Throws on invalid input.
 */
export function parseSmokeConfig(raw: string): SmokeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Smoke config is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Smoke config must be a JSON object");
  }
  const cfg = parsed as Record<string, unknown>;
  if (!Array.isArray(cfg["services"])) {
    throw new Error("Smoke config must have a 'services' array");
  }
  if (!Array.isArray(cfg["journeys"])) {
    throw new Error("Smoke config must have a 'journeys' array");
  }
  return cfg as unknown as SmokeConfig;
}

/**
 * Check whether a response includes all required security headers.
 * Returns the list of missing header names (empty = all present).
 */
export function checkSecurityHeaders(
  headers: Map<string, string>
): string[] {
  return REQUIRED_SECURITY_HEADERS.filter(
    (h) => !headers.has(h) || !headers.get(h)
  );
}

/**
 * Run a single health-ready check against a service endpoint.
 */
export async function runHealthCheck(
  endpoint: ServiceEndpoint,
  fetcher: HttpFetcher
): Promise<SmokeCheckResult> {
  const url = `${endpoint.baseUrl}/health/ready`;
  const start = performance.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let status: number;
    let headers: Map<string, string>;
    try {
      const resp = await fetcher.fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      status = resp.status;
      headers = resp.headers;
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Math.round(performance.now() - start);
    const missingHeaders = checkSecurityHeaders(headers);

    if (status < 200 || status >= 300) {
      return {
        name: `${endpoint.name}/health/ready`,
        url,
        passed: false,
        status,
        durationMs,
        error: `HTTP ${status} — expected 2xx`,
      };
    }

    if (missingHeaders.length > 0) {
      return {
        name: `${endpoint.name}/health/ready`,
        url,
        passed: false,
        status,
        durationMs,
        missingHeaders,
        error: `Missing required security headers: ${missingHeaders.join(", ")}`,
      };
    }

    return {
      name: `${endpoint.name}/health/ready`,
      url,
      passed: true,
      status,
      durationMs,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name: `${endpoint.name}/health/ready`,
      url,
      passed: false,
      durationMs,
      error: String(err),
    };
  }
}

/**
 * Run a single journey request.
 */
export async function runJourneyRequest(
  journey: JourneyRequest,
  serviceMap: Map<string, ServiceEndpoint>,
  fetcher: HttpFetcher
): Promise<SmokeCheckResult> {
  const endpoint = serviceMap.get(journey.service);
  if (!endpoint) {
    return {
      name: journey.name,
      url: journey.path,
      passed: false,
      error: `Service "${journey.service}" is not in the services list`,
    };
  }

  const url = `${endpoint.baseUrl}${journey.path}`;
  const expectedStatus = journey.expectStatus ?? 200;
  const start = performance.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let status: number;
    let headers: Map<string, string>;
    try {
      const resp = await fetcher.fetch(url, {
        method: journey.method,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: journey.body !== undefined ? JSON.stringify(journey.body) : undefined,
        signal: controller.signal,
      });
      status = resp.status;
      headers = resp.headers;
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Math.round(performance.now() - start);
    const missingHeaders = checkSecurityHeaders(headers);

    if (status !== expectedStatus) {
      return {
        name: journey.name,
        url,
        passed: false,
        status,
        durationMs,
        error: `HTTP ${status} — expected ${expectedStatus}`,
      };
    }

    if (missingHeaders.length > 0) {
      return {
        name: journey.name,
        url,
        passed: false,
        status,
        durationMs,
        missingHeaders,
        error: `Missing required security headers: ${missingHeaders.join(", ")}`,
      };
    }

    return { name: journey.name, url, passed: true, status, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name: journey.name,
      url,
      passed: false,
      durationMs,
      error: String(err),
    };
  }
}

/**
 * Run all health checks and journey requests from a smoke config.
 * Returns array of results — does NOT throw on individual failures.
 */
export async function runSmoke(
  config: SmokeConfig,
  fetcher: HttpFetcher
): Promise<SmokeCheckResult[]> {
  const serviceMap = new Map(config.services.map((s) => [s.name, s]));
  const results: SmokeCheckResult[] = [];

  // Health checks run concurrently.
  const healthResults = await Promise.all(
    config.services.map((svc) => runHealthCheck(svc, fetcher))
  );
  results.push(...healthResults);

  // Journey requests run sequentially to avoid thundering-herd on the smoke target.
  for (const journey of config.journeys) {
    const result = await runJourneyRequest(journey, serviceMap, fetcher);
    results.push(result);
  }

  return results;
}

// ── Node.js fetch adapter ─────────────────────────────────────────────────────

/**
 * Real HttpFetcher backed by Node 20 native fetch.
 */
export function makeNodeFetcher(): HttpFetcher {
  return {
    async fetch(url, opts) {
      const response = await globalThis.fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal as AbortSignal,
      });
      const headers = new Map<string, string>();
      response.headers.forEach((value, key) => {
        headers.set(key.toLowerCase(), value);
      });
      return { status: response.status, headers };
    },
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) configPath = resolve(args[++i] as string);
  }

  if (!configPath) {
    console.error("[smoke] ERROR: --config <path> is required");
    process.exit(2);
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    console.error(`[smoke] ERROR: Cannot read config ${configPath}: ${String(err)}`);
    process.exit(2);
  }

  let config: SmokeConfig;
  try {
    config = parseSmokeConfig(raw);
  } catch (err) {
    console.error(`[smoke] ERROR: ${String(err)}`);
    process.exit(2);
  }

  console.log(`[smoke] Running ${config.services.length} health checks and ${config.journeys.length} journey requests...`);

  const fetcher = makeNodeFetcher();
  const results = await runSmoke(config, fetcher);

  const passed = results.filter((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const duration = r.durationMs !== undefined ? ` (${r.durationMs}ms)` : "";
    console.log(`  [${status}] ${r.name}${duration}${r.error ? ` — ${r.error}` : ""}`);
  }

  console.log(`\n[smoke] ${passed.length}/${results.length} checks passed`);

  if (failed.length > 0) {
    console.error(`[smoke] FAILED — ${failed.length} check(s) failed:`);
    for (const r of failed) {
      console.error(`  - ${r.name}: ${r.error ?? "unknown failure"}`);
    }
    process.exit(1);
  }

  console.log("[smoke] All checks passed.");
  process.exit(0);
}

if (
  process.argv[1]?.endsWith("smoke.ts") ||
  process.argv[1]?.endsWith("smoke.js")
) {
  main().catch((err) => {
    console.error("[smoke] Fatal:", err);
    process.exit(2);
  });
}
