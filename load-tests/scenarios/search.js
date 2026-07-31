/**
 * k6 search journey load test.
 *
 * Exercises the flight, hotel, and car search endpoints through the API gateway.
 * Supplier calls are stubbed when X-Load-Test: true is present in headers so
 * the test isolates the data tier (RDS Proxy + PostgreSQL) from external APIs.
 *
 * R9 Exit Criterion: 600 rps (2× platform peak), 0 pool exhaustion errors,
 * search p95 < 3,000 ms.
 *
 * Usage:
 *   k6 run --env TARGET_BASE_URL=https://staging.example.com scenarios/search.js
 *   k6 run --env TARGET_BASE_URL=https://... --env RATE=600 --env DURATION=600s scenarios/search.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/** Counts HTTP 5xx responses attributable to the data tier (pool exhaustion). */
const dbPoolErrors = new Counter("db_pool_errors");

/** Distribution of search response times (excludes auth overhead). */
const searchDuration = new Trend("search_duration_ms", true);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtures = new SharedArray("search-fixtures", () => {
  return JSON.parse(open("../fixtures/search-request.json"));
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.TARGET_BASE_URL || "http://localhost:3000";
const RATE = parseInt(__ENV.RATE || "300", 10);
const DURATION = __ENV.DURATION || "300s";
const RAMP_DURATION = __ENV.RAMP_DURATION || "60s";

export const options = {
  scenarios: {
    search_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.ceil(RATE * 1.5),
      maxVUs: Math.ceil(RATE * 3),
    },
    search_ramp: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      stages: [
        { target: RATE, duration: RAMP_DURATION },
      ],
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },

  thresholds: {
    // R9 exit criterion: search p95 < 3,000 ms
    "http_req_duration{type:search}": ["p(95)<3000"],
    // No pool exhaustion errors
    db_pool_errors: ["count<1"],
    // Overall error rate < 0.1%
    http_req_failed: ["rate<0.001"],
    // Custom search duration metric
    search_duration_ms: ["p(95)<3000"],
  },
};

// ---------------------------------------------------------------------------
// Default function (VU entrypoint)
// ---------------------------------------------------------------------------

export default function () {
  const headers = {
    "Content-Type": "application/json",
    "X-Load-Test": "true",      // signals gateway to stub supplier backends
    "X-Correlation-ID": `lt-${__VU}-${__ITER}`,
  };

  // Pick a search type per VU to distribute load across all three search services.
  const searchTypes = ["flight", "hotel", "car"];
  const searchType = searchTypes[__VU % searchTypes.length];
  const payload = JSON.stringify(fixtures[0][searchType]);

  const startTime = Date.now();
  const response = http.post(
    `${BASE_URL}/api/v1/search`,
    payload,
    { headers, tags: { type: "search" } },
  );
  searchDuration.add(Date.now() - startTime);

  const isSuccess = check(response, {
    "search status 200": (r) => r.status === 200,
    "search returns results array": (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.results) || Array.isArray(body.offers);
      } catch {
        return false;
      }
    },
  });

  // Classify 5xx errors attributable to pool exhaustion.
  if (response.status >= 500) {
    let isPoolError = false;
    try {
      const body = JSON.parse(response.body);
      const code = body?.error?.code ?? "";
      // SUPPLIER_UNAVAILABLE (502) and INTERNAL_ERROR (500) from the DB layer
      // surface as these codes; pool timeout surfaces in the X-Prisma-Pool header.
      isPoolError =
        code === "INTERNAL_ERROR" ||
        response.headers["X-Prisma-Pool-Timeout"] === "1";
    } catch {
      isPoolError = response.status === 500;
    }
    if (isPoolError) dbPoolErrors.add(1);
  }

  sleep(0.1 + Math.random() * 0.2); // 100–300 ms think time
}
