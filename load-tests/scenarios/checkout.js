/**
 * k6 checkout journey load test.
 *
 * Exercises the booking creation → payment intent creation path.
 * Supplier calls and Stripe payment creation are stubbed when
 * X-Load-Test: true is present so the test isolates the data tier.
 *
 * R9 Exit Criterion: no pool exhaustion errors, checkout ack p95 < 5,000 ms.
 *
 * Usage:
 *   k6 run --env TARGET_BASE_URL=https://staging.example.com scenarios/checkout.js
 */
import http from "k6/http";
import { check, sleep, group } from "k6";
import { Counter, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const dbPoolErrors = new Counter("db_pool_errors");
const checkoutDuration = new Trend("checkout_duration_ms", true);
const bookingCreateDuration = new Trend("booking_create_duration_ms", true);
const paymentIntentDuration = new Trend("payment_intent_duration_ms", true);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fixtures = new SharedArray("checkout-fixtures", () => {
  return [JSON.parse(open("../fixtures/checkout-request.json"))];
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.TARGET_BASE_URL || "http://localhost:3000";
const RATE = parseInt(__ENV.RATE || "50", 10); // checkout is heavier; default 50 rps
const DURATION = __ENV.DURATION || "300s";

export const options = {
  scenarios: {
    checkout_load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.ceil(RATE * 2),
      maxVUs: Math.ceil(RATE * 4),
    },
  },

  thresholds: {
    // R9 exit criterion: checkout ack p95 < 5,000 ms
    "http_req_duration{type:checkout}": ["p(95)<5000"],
    checkout_duration_ms: ["p(95)<5000"],
    // No pool exhaustion errors
    db_pool_errors: ["count<1"],
    // Overall error rate < 0.1%
    http_req_failed: ["rate<0.001"],
  },
};

// ---------------------------------------------------------------------------
// Auth token stub — in real staging a JWT is issued by auth-service.
// The X-Load-Test header signals the gateway to accept a synthetic token.
// ---------------------------------------------------------------------------

function getAuthHeaders(vuId) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer lt-synthetic-token-vu-${vuId}`,
    "X-Load-Test": "true",
    "X-Correlation-ID": `checkout-lt-${vuId}-${__ITER}`,
  };
}

// ---------------------------------------------------------------------------
// Default function (VU entrypoint)
// ---------------------------------------------------------------------------

export default function () {
  const headers = getAuthHeaders(__VU);
  const fixture = fixtures[0];
  const idempotencyKey = uuidv4();

  let bookingId = null;
  const journeyStart = Date.now();

  // Step 1: Create booking (PENDING state)
  group("create_booking", () => {
    const body = JSON.stringify({
      ...fixture.createBookingRequest,
      idempotencyKey,
    });

    const t0 = Date.now();
    const res = http.post(
      `${BASE_URL}/api/v1/bookings`,
      body,
      { headers, tags: { type: "checkout" } },
    );
    bookingCreateDuration.add(Date.now() - t0);

    const ok = check(res, {
      "booking create 201": (r) => r.status === 201,
      "booking id returned": (r) => {
        try {
          const b = JSON.parse(r.body);
          return typeof b.id === "string" && b.id.length > 0;
        } catch {
          return false;
        }
      },
    });

    if (ok && res.status === 201) {
      try {
        bookingId = JSON.parse(res.body).id;
      } catch {
        bookingId = null;
      }
    }

    trackPoolError(res);
  });

  if (!bookingId) {
    sleep(0.5);
    return;
  }

  // Step 2: Create PaymentIntent (returns client_secret to front end)
  group("create_payment_intent", () => {
    const body = JSON.stringify({
      ...fixture.paymentIntentRequest,
      bookingId,
      idempotencyKey,
    });

    const t0 = Date.now();
    const res = http.post(
      `${BASE_URL}/api/v1/payments/intents`,
      body,
      { headers, tags: { type: "checkout" } },
    );
    paymentIntentDuration.add(Date.now() - t0);

    check(res, {
      "payment intent 201": (r) => r.status === 201,
      "client_secret returned": (r) => {
        try {
          const b = JSON.parse(r.body);
          return typeof b.clientSecret === "string";
        } catch {
          return false;
        }
      },
    });

    trackPoolError(res);
  });

  checkoutDuration.add(Date.now() - journeyStart);
  sleep(0.2 + Math.random() * 0.3);
}

function trackPoolError(response) {
  if (response.status >= 500) {
    try {
      const body = JSON.parse(response.body);
      const code = body?.error?.code ?? "";
      if (code === "INTERNAL_ERROR" || response.headers["X-Prisma-Pool-Timeout"] === "1") {
        dbPoolErrors.add(1);
      }
    } catch {
      if (response.status === 500) dbPoolErrors.add(1);
    }
  }
}
