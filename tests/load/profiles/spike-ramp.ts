/**
 * Profile B — Spike Ramp
 *
 * Ramps from steady state to 900 rps (3× projected peak) within 10 minutes
 * and holds for an observation period. Proves that the ECS step-scaling
 * policy (100% PercentChangeInCapacity on a 2-minute ALB
 * RequestCountPerTarget breach) delivers sufficient capacity within the
 * required window without manual intervention.
 *
 * Thresholds loaded from tests/load/config/thresholds.json.
 * All threshold values are ASSUMPTION pending sponsor ratification.
 *
 * Run:
 *   k6 run tests/load/profiles/spike-ramp.ts \
 *     -e GW_BASE_URL=https://api-staging.travel.internal \
 *     -e LOAD_TEST_TOKEN=<bearer> \
 *     --out json=results/spike-ramp.json
 *
 * WAF note: distribute generator source addresses or allow-list the
 * generator IP range in the WAF before running to avoid hitting the
 * 2000 req/5 min per-IP rate limit. See docs/runbooks/load-and-spike-run.md.
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const cfg = JSON.parse(open("../config/thresholds.json"));
const searchParams = JSON.parse(open("../data/synthetic-search-parameters.json"));

const GW_BASE = __ENV.GW_BASE_URL || "https://api-staging.travel.internal";
const TOKEN = __ENV.LOAD_TEST_TOKEN || "";

const BASELINE_SECS = cfg.profile_b.baseline_duration_seconds;
const RAMP_SECS     = cfg.profile_b.ramp_duration_seconds;      // 600 s = 10 min
const HOLD_SECS     = cfg.profile_b.hold_duration_seconds;      // 300 s observation
const COOLDOWN_SECS = cfg.profile_b.cooldown_duration_seconds;

const PEAK_RPS  = cfg.throughput_rps.sustained_peak;  // 300
const SPIKE_RPS = cfg.throughput_rps.spike_target;    // 900

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const searchHitLatency  = new Trend("spike_search_hit_p95_ms", true);
const searchMissLatency = new Trend("spike_search_miss_p95_ms", true);
const checkoutLatency   = new Trend("spike_checkout_p95_ms", true);

const serverFaultCounter = new Counter("spike_server_faults_total");
const serverFaultRate    = new Rate("spike_server_fault_rate");
const checkoutFailRate   = new Rate("spike_checkout_fail_rate");

// ---------------------------------------------------------------------------
// Shared data
// ---------------------------------------------------------------------------

const hitFlights = new SharedArray("spike_hit_flights", function () {
  return searchParams.hit_cohort.flights;
});
const hitHotels = new SharedArray("spike_hit_hotels", function () {
  return searchParams.hit_cohort.hotels;
});
const hitCars = new SharedArray("spike_hit_cars", function () {
  return searchParams.hit_cohort.cars;
});
const missFlights = new SharedArray("spike_miss_flights", function () {
  return searchParams.miss_cohort.flights;
});
const missHotels = new SharedArray("spike_miss_hotels", function () {
  return searchParams.miss_cohort.hotels;
});
const missCars = new SharedArray("spike_miss_cars", function () {
  return searchParams.miss_cohort.cars;
});
const checkoutOffers = new SharedArray("spike_checkout_offers", function () {
  return searchParams.checkout.offers;
});

// ---------------------------------------------------------------------------
// Scenario options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // Baseline — establish 1× peak before the ramp
    baseline: {
      executor: "constant-arrival-rate",
      rate: PEAK_RPS,
      timeUnit: "1s",
      duration: `${BASELINE_SECS}s`,
      preAllocatedVUs: 100,
      maxVUs: 250,
    },
    // Spike ramp — open-loop arrival rate climbs to 3× peak in RAMP_SECS
    // ramping-arrival-rate is used (not ramping-vus) so the arrival rate is
    // independent of response time — this models real traffic, not VU saturation.
    spike_ramp: {
      executor: "ramping-arrival-rate",
      startRate: PEAK_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 800,
      stages: [
        { target: SPIKE_RPS, duration: `${RAMP_SECS}s` },
      ],
      startTime: `${BASELINE_SECS}s`,
    },
    // Hold at 3× for scaling observation
    spike_hold: {
      executor: "constant-arrival-rate",
      rate: SPIKE_RPS,
      timeUnit: "1s",
      duration: `${HOLD_SECS}s`,
      preAllocatedVUs: 300,
      maxVUs: 900,
      startTime: `${BASELINE_SECS + RAMP_SECS}s`,
    },
    // Cooldown
    cooldown: {
      executor: "ramping-arrival-rate",
      startRate: SPIKE_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 800,
      stages: [
        { target: 0, duration: `${COOLDOWN_SECS}s` },
      ],
      startTime: `${BASELINE_SECS + RAMP_SECS + HOLD_SECS}s`,
    },
  },

  thresholds: {
    // During baseline and ramp, p95 budgets should hold even as capacity expands.
    "spike_search_hit_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.search_hard_alert_ceiling}`, abortOnFail: true },
    ],
    "spike_search_miss_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.search_hard_alert_ceiling}`, abortOnFail: true },
    ],
    "spike_checkout_p95_ms": [
      // Checkout may degrade during saturation — record rather than abort
      { threshold: `p(95)<${cfg.latency_p95_ms.checkout_acknowledgement * 2}`, abortOnFail: false },
    ],
    "spike_server_fault_rate": [
      { threshold: `rate<${cfg.guardrails.server_fault_rate_max_pct / 100}`, abortOnFail: false },
    ],
    "spike_checkout_fail_rate": [
      { threshold: `rate<${cfg.guardrails.checkout_platform_failure_rate_max_pct / 100}`, abortOnFail: false },
    ],
    "http_req_failed": [
      { threshold: `rate<${cfg.guardrails.server_fault_rate_max_pct / 100}`, abortOnFail: false },
    ],
  },

  tags: { profile: "spike-ramp", environment: __ENV.LOAD_ENV || "staging" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "X-Load-Test": "true",
    "X-Load-Test-Profile": "spike-ramp",
  };
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scenarioWeight(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let rand = Math.random() * total;
  for (const [key, w] of entries) {
    rand -= w;
    if (rand <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ---------------------------------------------------------------------------
// Main VU function
// ---------------------------------------------------------------------------

export default function (): void {
  const mix = cfg.scenario_mix_weights;
  const scenario = scenarioWeight({
    flight_hit:  mix.flight_search_hit,
    flight_miss: mix.flight_search_miss,
    hotel_hit:   mix.hotel_search_hit,
    hotel_miss:  mix.hotel_search_miss,
    car_hit:     mix.car_search_hit,
    car_miss:    mix.car_search_miss,
    checkout:    mix.checkout,
  });

  switch (scenario) {
    case "flight_hit":   doSearchHit("flights"); break;
    case "flight_miss":  doSearchMiss("flights"); break;
    case "hotel_hit":    doSearchHit("hotels"); break;
    case "hotel_miss":   doSearchMiss("hotels"); break;
    case "car_hit":      doSearchHit("cars"); break;
    case "car_miss":     doSearchMiss("cars"); break;
    case "checkout":     doCheckout(); break;
  }

  sleep(0);
}

// ---------------------------------------------------------------------------
// Scenario implementations
// ---------------------------------------------------------------------------

function doSearchHit(type: "flights" | "hotels" | "cars"): void {
  const paramSet = type === "flights" ? hitFlights : type === "hotels" ? hitHotels : hitCars;
  const params = pickRandom(paramSet as unknown[]) as Record<string, unknown>;

  group(`spike_search_hit_${type}`, () => {
    const res = http.post(
      `${GW_BASE}/api/v1/search/${type}`,
      JSON.stringify(params),
      { headers: headers(), tags: { cohort: "hit", journey: type } },
    );

    check(res, { "status 200": (r) => r.status === 200 });

    searchHitLatency.add(res.timings.duration);
    const fault = res.status >= 500;
    serverFaultRate.add(fault);
    if (fault) serverFaultCounter.add(1);
  });
}

function doSearchMiss(type: "flights" | "hotels" | "cars"): void {
  const paramSet = type === "flights" ? missFlights : type === "hotels" ? missHotels : missCars;
  const idx = (__VU * 1000 + __ITER) % (paramSet as unknown[]).length;
  const params = (paramSet as unknown[])[idx] as Record<string, unknown>;

  group(`spike_search_miss_${type}`, () => {
    const res = http.post(
      `${GW_BASE}/api/v1/search/${type}`,
      JSON.stringify(params),
      { headers: headers(), tags: { cohort: "miss", journey: type } },
    );

    check(res, { "status 200": (r) => r.status === 200 });

    searchMissLatency.add(res.timings.duration);
    const fault = res.status >= 500;
    serverFaultRate.add(fault);
    if (fault) serverFaultCounter.add(1);
  });
}

function doCheckout(): void {
  const offer = pickRandom(checkoutOffers as unknown[]) as Record<string, unknown>;

  group("spike_checkout", () => {
    const idempotencyKey = `spike_${__VU}_${__ITER}`;
    const body = {
      bookingType: offer.bookingType,
      offerId: offer.id,
      offerPrice: offer.offerPrice,
      currency: offer.currency,
      passengers: [searchParams.checkout.passengers[0]],
      contactEmail: `spiketest${__VU}@example.invalid`,
      idempotencyKey,
    };

    const res = http.post(
      `${GW_BASE}/api/v1/bookings`,
      JSON.stringify(body),
      { headers: headers(), tags: { journey: "checkout" } },
    );

    const platformError = res.status >= 500 || res.status === 422;
    check(res, {
      "booking accepted": (r) => r.status === 201 || r.status === 202,
    });

    checkoutLatency.add(res.timings.duration);
    checkoutFailRate.add(platformError);

    const fault = res.status >= 500;
    serverFaultRate.add(fault);
    if (fault) serverFaultCounter.add(1);
  });
}
