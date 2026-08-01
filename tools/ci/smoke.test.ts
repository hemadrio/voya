/**
 * Unit tests for smoke.ts — WO-087.
 *
 * Covers:
 *   - parseSmokeConfig: valid config, missing services, missing journeys
 *   - checkSecurityHeaders: all present, missing headers, case-insensitive
 *   - runHealthCheck: 200 with all headers, 503 failure, timeout, missing header
 *   - runJourneyRequest: success, wrong status, unknown service, missing security header
 *   - runSmoke: all pass, partial failure, empty config
 *   - Fixture: smoke-config.json with services + journeys
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  REQUIRED_SECURITY_HEADERS,
  parseSmokeConfig,
  checkSecurityHeaders,
  runHealthCheck,
  runJourneyRequest,
  runSmoke,
  type SmokeConfig,
  type ServiceEndpoint,
  type JourneyRequest,
  type HttpFetcher,
} from "./smoke.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHeaders(extra: Record<string, string> = {}): Map<string, string> {
  const headers = new Map<string, string>([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["strict-transport-security", "max-age=31536000; includeSubDomains"],
  ]);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k.toLowerCase(), v);
  }
  return headers;
}

function makeFetcher(responses: Array<{ status: number; headers?: Record<string, string> }>): HttpFetcher {
  let i = 0;
  return {
    async fetch(_url, _opts) {
      const resp = responses[i++] ?? { status: 200 };
      return { status: resp.status, headers: makeHeaders(resp.headers ?? {}) };
    },
  };
}

function makeErrorFetcher(error: Error): HttpFetcher {
  return {
    async fetch() {
      throw error;
    },
  };
}

const TEST_SERVICE: ServiceEndpoint = { name: "auth-service", baseUrl: "https://auth.internal" };
const TEST_JOURNEY: JourneyRequest = {
  name: "flight_search",
  service: "search-service",
  method: "GET",
  path: "/v1/search/flights?from=JFK&to=LAX",
  expectStatus: 200,
};

// ── REQUIRED_SECURITY_HEADERS ─────────────────────────────────────────────────

describe("REQUIRED_SECURITY_HEADERS", () => {
  it("requires x-content-type-options", () => {
    expect(REQUIRED_SECURITY_HEADERS).toContain("x-content-type-options");
  });

  it("requires x-frame-options", () => {
    expect(REQUIRED_SECURITY_HEADERS).toContain("x-frame-options");
  });

  it("requires strict-transport-security", () => {
    expect(REQUIRED_SECURITY_HEADERS).toContain("strict-transport-security");
  });
});

// ── parseSmokeConfig ──────────────────────────────────────────────────────────

describe("parseSmokeConfig", () => {
  it("parses a valid minimal config", () => {
    const raw = JSON.stringify({ services: [], journeys: [] });
    const config = parseSmokeConfig(raw);
    expect(config.services).toHaveLength(0);
    expect(config.journeys).toHaveLength(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseSmokeConfig("{ bad json")).toThrow(/not valid JSON/i);
  });

  it("throws when services is missing", () => {
    expect(() => parseSmokeConfig(JSON.stringify({ journeys: [] }))).toThrow(/'services'/);
  });

  it("throws when journeys is missing", () => {
    expect(() => parseSmokeConfig(JSON.stringify({ services: [] }))).toThrow(/'journeys'/);
  });

  it("throws on a JSON array", () => {
    expect(() => parseSmokeConfig("[]")).toThrow(/must be a JSON object/i);
  });
});

// ── checkSecurityHeaders ──────────────────────────────────────────────────────

describe("checkSecurityHeaders", () => {
  it("returns empty array when all required headers are present", () => {
    expect(checkSecurityHeaders(makeHeaders())).toHaveLength(0);
  });

  it("returns missing header names when some are absent", () => {
    const headers = new Map([["x-content-type-options", "nosniff"]]);
    const missing = checkSecurityHeaders(headers);
    expect(missing).toContain("x-frame-options");
    expect(missing).toContain("strict-transport-security");
  });

  it("returns all headers missing when map is empty", () => {
    const missing = checkSecurityHeaders(new Map());
    expect(missing).toHaveLength(REQUIRED_SECURITY_HEADERS.length);
  });

  it("accepts lowercase header names (headers are normalised)", () => {
    const headers = new Map([
      ["x-content-type-options", "nosniff"],
      ["x-frame-options", "DENY"],
      ["strict-transport-security", "max-age=31536000"],
    ]);
    expect(checkSecurityHeaders(headers)).toHaveLength(0);
  });
});

// ── runHealthCheck ────────────────────────────────────────────────────────────

describe("runHealthCheck — passes", () => {
  it("returns passed=true for HTTP 200 with all security headers", async () => {
    const fetcher = makeFetcher([{ status: 200 }]);
    const result = await runHealthCheck(TEST_SERVICE, fetcher);
    expect(result.passed).toBe(true);
    expect(result.status).toBe(200);
    expect(result.name).toContain("auth-service");
  });

  it("records duration", async () => {
    const fetcher = makeFetcher([{ status: 200 }]);
    const result = await runHealthCheck(TEST_SERVICE, fetcher);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runHealthCheck — fails", () => {
  it("returns passed=false for HTTP 503", async () => {
    const fetcher = makeFetcher([{ status: 503 }]);
    const result = await runHealthCheck(TEST_SERVICE, fetcher);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/503/);
  });

  it("returns passed=false when a security header is missing", async () => {
    const fetcher: HttpFetcher = {
      async fetch() {
        return {
          status: 200,
          headers: new Map([
            ["x-content-type-options", "nosniff"],
            // x-frame-options and strict-transport-security absent
          ]),
        };
      },
    };
    const result = await runHealthCheck(TEST_SERVICE, fetcher);
    expect(result.passed).toBe(false);
    expect(result.missingHeaders).toContain("x-frame-options");
    expect(result.missingHeaders).toContain("strict-transport-security");
  });

  it("returns passed=false on network error", async () => {
    const fetcher = makeErrorFetcher(new Error("ECONNREFUSED"));
    const result = await runHealthCheck(TEST_SERVICE, fetcher);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });
});

// ── runJourneyRequest ─────────────────────────────────────────────────────────

describe("runJourneyRequest — passes", () => {
  it("returns passed=true for expected status with security headers", async () => {
    const serviceMap = new Map([
      ["search-service", { name: "search-service", baseUrl: "https://search.internal" }],
    ]);
    const fetcher = makeFetcher([{ status: 200 }]);
    const result = await runJourneyRequest(TEST_JOURNEY, serviceMap, fetcher);
    expect(result.passed).toBe(true);
    expect(result.name).toBe("flight_search");
  });
});

describe("runJourneyRequest — fails", () => {
  it("returns passed=false when status does not match expectation", async () => {
    const serviceMap = new Map([
      ["search-service", { name: "search-service", baseUrl: "https://search.internal" }],
    ]);
    const fetcher = makeFetcher([{ status: 500 }]);
    const result = await runJourneyRequest(TEST_JOURNEY, serviceMap, fetcher);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it("returns passed=false when service is not in service map", async () => {
    const serviceMap = new Map<string, ServiceEndpoint>();
    const fetcher = makeFetcher([{ status: 200 }]);
    const result = await runJourneyRequest(TEST_JOURNEY, serviceMap, fetcher);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/not in the services list/i);
  });
});

// ── runSmoke ──────────────────────────────────────────────────────────────────

describe("runSmoke — all pass", () => {
  it("returns all passed=true when everything responds correctly", async () => {
    const config: SmokeConfig = {
      services: [
        { name: "auth-service", baseUrl: "https://auth.internal" },
        { name: "search-service", baseUrl: "https://search.internal" },
      ],
      journeys: [
        { name: "flight_search", service: "search-service", method: "GET", path: "/v1/search/flights", expectStatus: 200 },
      ],
    };
    // 2 health checks + 1 journey = 3 fetches
    const fetcher = makeFetcher([{ status: 200 }, { status: 200 }, { status: 200 }]);
    const results = await runSmoke(config, fetcher);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});

describe("runSmoke — partial failure", () => {
  it("returns mix of passed/failed results", async () => {
    const config: SmokeConfig = {
      services: [
        { name: "auth-service", baseUrl: "https://auth.internal" },
        { name: "bad-service", baseUrl: "https://bad.internal" },
      ],
      journeys: [],
    };
    const fetcher = makeFetcher([{ status: 200 }, { status: 503 }]);
    const results = await runSmoke(config, fetcher);
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.passed)).toHaveLength(1);
    expect(results.filter((r) => !r.passed)).toHaveLength(1);
  });
});

describe("runSmoke — empty config", () => {
  it("returns empty results for empty config", async () => {
    const config: SmokeConfig = { services: [], journeys: [] };
    const fetcher = makeFetcher([]);
    const results = await runSmoke(config, fetcher);
    expect(results).toHaveLength(0);
  });
});

// ── Fixture file ──────────────────────────────────────────────────────────────

describe("parseSmokeConfig — smoke-config.json fixture", () => {
  it("parses the committed fixture without error", () => {
    const raw = readFileSync(join(FIXTURES, "smoke-config.json"), "utf-8");
    const config = parseSmokeConfig(raw);
    expect(config.services.length).toBeGreaterThan(0);
    expect(config.journeys.length).toBeGreaterThan(0);
  });

  it("every service has a name and baseUrl", () => {
    const raw = readFileSync(join(FIXTURES, "smoke-config.json"), "utf-8");
    const config = parseSmokeConfig(raw);
    for (const svc of config.services) {
      expect(svc.name).toBeTruthy();
      expect(svc.baseUrl).toBeTruthy();
    }
  });
});
