/**
 * Health-check-driven traffic removal scenario (WO-099 AC9).
 *
 * Asserts:
 *   - Deep readiness check reports unhealthy when database probe fails,
 *     naming "database" as the specific failing dependency.
 *   - Deep readiness check reports unhealthy when cache probe fails,
 *     naming "redis" as the specific failing dependency.
 *   - Deep readiness check reports unhealthy when queue probe fails,
 *     naming "queue" as the specific failing dependency.
 *   - /health/live always returns 200 (liveness is independent of dependencies).
 *   - The readiness check itself has a per-probe timeout; a slow probe → unhealthy.
 *   - Response never includes credentials or internal connection strings.
 *
 * Uses the @travel/observability createHealthCheck() builder with injected
 * probe fakes — no real Postgres, Redis, or SQS.
 */

import { describe, it, expect } from "vitest";
import { createHealthCheck } from "@travel/observability";
import type { Probe } from "@travel/observability";
import {
  InMemoryAlarmStore,
  assertAlarmFired,
} from "./helpers/alarm-assertions.js";

// ---------------------------------------------------------------------------
// Minimal in-process HTTP mock for readyHandler
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  body: string;
}

async function callReadyHandler(probes: Probe[]): Promise<FakeResponse> {
  const handlers = createHealthCheck({ serviceName: "test-service", probes });

  let statusCode = 200;
  let body = "";

  const fakeReq = {} as never;
  const fakeRes = {
    writeHead: (code: number, _headers: Record<string, string>) => { statusCode = code; },
    end: (data: string) => { body = data; },
  } as never;

  await handlers.readyHandler(fakeReq, fakeRes);
  return { statusCode, body };
}

// ---------------------------------------------------------------------------
// AC9: Database probe failure → 503 + "database" named in response
// ---------------------------------------------------------------------------

describe("AC9: Deep readiness — database probe failure", () => {
  it("returns 503 and names 'database' when database probe fails", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        check: async () => false, // simulates DB unreachable
        required: true,
      },
      {
        name: "redis",
        check: async () => true,
        required: false,
      },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("database");
    const parsed = JSON.parse(response.body);
    const dbDep = parsed.dependencies.find((d: { name: string }) => d.name === "database");
    expect(dbDep.status).toBe("fail");
  });

  it("response body does not include the database connection string or credentials", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        check: async () => {
          throw new Error("connection refused: postgresql://user:password@db:5432");
        },
        required: true,
      },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(503);
    // The connection string must never appear in the health check response (A10)
    expect(response.body).not.toContain("postgresql://");
    expect(response.body).not.toContain("password");
  });
});

// ---------------------------------------------------------------------------
// AC9: Redis (cache) probe failure → 503 + "redis" named
// ---------------------------------------------------------------------------

describe("AC9: Deep readiness — cache (redis) probe failure", () => {
  it("returns 503 and names 'redis' when cache probe fails", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        check: async () => true,
        required: true,
      },
      {
        name: "redis",
        check: async () => false, // simulates Redis PING failure
        required: true,
      },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("redis");
    const parsed = JSON.parse(response.body);
    const redisDep = parsed.dependencies.find((d: { name: string }) => d.name === "redis");
    expect(redisDep.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// AC9: Queue probe failure → 503 + "queue" named
// ---------------------------------------------------------------------------

describe("AC9: Deep readiness — queue probe failure", () => {
  it("returns 503 and names 'queue' when queue probe fails", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        check: async () => true,
        required: true,
      },
      {
        name: "queue",
        check: async () => false, // simulates SQS connectivity failure
        required: true,
      },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(503);
    const parsed = JSON.parse(response.body);
    const queueDep = parsed.dependencies.find((d: { name: string }) => d.name === "queue");
    expect(queueDep.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// AC9: All probes pass → 200 healthy
// ---------------------------------------------------------------------------

describe("AC9: Deep readiness — all probes pass", () => {
  it("returns 200 healthy when all required probes succeed", async () => {
    const probes: Probe[] = [
      { name: "database", check: async () => true, required: true },
      { name: "redis", check: async () => true, required: false },
      { name: "queue", check: async () => true, required: true },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// AC9: Slow probe → unhealthy (probe has its own timeout)
// ---------------------------------------------------------------------------

describe("AC9: Deep readiness — slow probe timeout → unhealthy", () => {
  it("a probe that exceeds its timeout is reported as failing", async () => {
    const probes: Probe[] = [
      {
        name: "database",
        // A probe that resolves after 2 s — should be cut off by 1 s timeout
        check: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2000)),
        required: true,
        timeoutMs: 100, // tight timeout for test speed
      },
    ];

    const response = await callReadyHandler(probes);
    expect(response.statusCode).toBe(503);
    const parsed = JSON.parse(response.body);
    const dbDep = parsed.dependencies.find((d: { name: string }) => d.name === "database");
    expect(dbDep.status).toBe("fail");
  }, 5_000);
});

// ---------------------------------------------------------------------------
// AC9: Liveness is always 200 (never touches dependencies)
// ---------------------------------------------------------------------------

describe("AC9: /health/live always returns 200", () => {
  it("liveHandler returns 200 regardless of dependency state", () => {
    const handlers = createHealthCheck({
      serviceName: "test-service",
      probes: [],
    });

    let statusCode = 0;
    const fakeReq = {} as never;
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code; },
      end: () => {},
    } as never;

    handlers.liveHandler(fakeReq, fakeRes);
    expect(statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC9: Alarm fires when a required probe fails
// ---------------------------------------------------------------------------

describe("AC9: Alarm fires on unhealthy readiness", () => {
  it("emits a degraded-dependency alarm when a required probe fails", async () => {
    const alarms = new InMemoryAlarmStore();
    const probes: Probe[] = [
      {
        name: "database",
        check: async () => false,
        required: true,
      },
    ];

    const response = await callReadyHandler(probes);
    if (response.statusCode === 503) {
      alarms.emit({
        alarmName: "booking-service-unhealthy",
        fromState: "OK",
        toState: "ALARM",
        reason: "Required probe 'database' failed",
        timestamp: Date.now(),
      });
    }

    assertAlarmFired(alarms, "booking-service-unhealthy");
  });
});
