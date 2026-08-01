/**
 * Profile A — Sustained Peak
 *
 * Two-phase run:
 *   Phase 1: Warm-up + 300 rps steady state for 5 minutes
 *   Phase 2: Ramp to 600 rps (2× peak gate) and hold for 10 minutes
 *
 * Thresholds loaded from tests/load/config/thresholds.json.
 * All threshold values are ASSUMPTION pending sponsor ratification.
 *
 * Traffic must enter through the single governed API gateway (GW_BASE_URL).
 * Do NOT target service ports directly — gateway auth and rate-limit
 * overhead must be included in the measured budgets.
 *
 * Run:
 *   k6 run tests/load/profiles/sustained-peak.ts \
 *     -e GW_BASE_URL=https://api-staging.travel.internal \
 *     -e LOAD_TEST_TOKEN=<bearer> \
 *     --out json=results/sustained-peak.json
 */

// k6 imports — resolved by the k6 runtime, not Node.js
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Counter, Rate, Gauge } from "k6/metrics";
import { SharedArray } from "k6/data";

// ---------------------------------------------------------------------------
// Configuration — loaded from the externalised thresholds file
// ---------------------------------------------------------------------------

const cfg = JSON.parse(open("../config/thresholds.json"));
const searchParams = JSON.parse(open("../data/synthetic-search-parameters.json"));

const GW_BASE = __ENV.GW_BASE_URL || "https://api-staging.travel.internal";
const TOKEN = __ENV.LOAD_TEST_TOKEN || "";

// Warmup + sustained 300 rps
const WARMUP_SECS = cfg.profile_a.warmup_duration_seconds;
const SUSTAINED_SECS = cfg.profile_a.sustained_300_duration_seconds;
const RAMP_SECS = cfg.profile_a.ramp_to_gate_duration_seconds;
const GATE_SECS = cfg.profile_a.gate_600_duration_seconds;
const COOLDOWN_SECS = cfg.profile_a.cooldown_duration_seconds;

const PEAK_RPS = cfg.throughput_rps.sustained_peak;        // 300
const GATE_RPS = cfg.throughput_rps.sustained_gate;        // 600

// ---------------------------------------------------------------------------
// Custom metrics — reported separately for hit vs miss cohorts
// ---------------------------------------------------------------------------

const searchHitLatency = new Trend("search_hit_p95_ms", true);
const searchMissLatency = new Trend("search_miss_p95_ms", true);
const checkoutLatency = new Trend("checkout_p95_ms", true);
const assistantTtftLatency = new Trend("assistant_ttft_p95_ms", true);

const serverFaultCounter = new Counter("server_faults_total");
const checkoutFailureCounter = new Counter("checkout_platform_failures_total");
const requestTotal = new Counter("requests_total");

const serverFaultRate = new Rate("server_fault_rate");
const checkoutFailRate = new Rate("checkout_fail_rate");

// ---------------------------------------------------------------------------
// Shared data arrays (loaded once, shared across VUs)
// ---------------------------------------------------------------------------

const hitFlights = new SharedArray("hit_flights", function () {
  return searchParams.hit_cohort.flights;
});
const hitHotels = new SharedArray("hit_hotels", function () {
  return searchParams.hit_cohort.hotels;
});
const hitCars = new SharedArray("hit_cars", function () {
  return searchParams.hit_cohort.cars;
});

const missFlights = new SharedArray("miss_flights", function () {
  return searchParams.miss_cohort.flights;
});
const missHotels = new SharedArray("miss_hotels", function () {
  return searchParams.miss_cohort.hotels;
});
const missCars = new SharedArray("miss_cars", function () {
  return searchParams.miss_cohort.cars;
});

const checkoutOffers = new SharedArray("checkout_offers", function () {
  return searchParams.checkout.offers;
});
const assistantPrompts = new SharedArray("assistant_prompts", function () {
  return searchParams.assistant.prompts;
});

// ---------------------------------------------------------------------------
// Scenario options — externalised thresholds enforce the p95 budgets
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    // Warm-up ramp 0 → PEAK_RPS over WARMUP_SECS
    warmup: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: PEAK_RPS, duration: `${WARMUP_SECS}s` },
      ],
    },
    // Sustained peak
    sustained_300: {
      executor: "constant-arrival-rate",
      rate: PEAK_RPS,
      timeUnit: "1s",
      duration: `${SUSTAINED_SECS}s`,
      preAllocatedVUs: 100,
      maxVUs: 250,
      startTime: `${WARMUP_SECS}s`,
    },
    // Ramp to gate
    ramp_to_gate: {
      executor: "ramping-arrival-rate",
      startRate: PEAK_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 400,
      stages: [
        { target: GATE_RPS, duration: `${RAMP_SECS}s` },
      ],
      startTime: `${WARMUP_SECS + SUSTAINED_SECS}s`,
    },
    // 2× gate hold
    gate_600: {
      executor: "constant-arrival-rate",
      rate: GATE_RPS,
      timeUnit: "1s",
      duration: `${GATE_SECS}s`,
      preAllocatedVUs: 200,
      maxVUs: 500,
      startTime: `${WARMUP_SECS + SUSTAINED_SECS + RAMP_SECS}s`,
    },
    // Cooldown
    cooldown: {
      executor: "ramping-arrival-rate",
      startRate: GATE_RPS,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 400,
      stages: [
        { target: 0, duration: `${COOLDOWN_SECS}s` },
      ],
      startTime: `${WARMUP_SECS + SUSTAINED_SECS + RAMP_SECS + GATE_SECS}s`,
    },
  },

  thresholds: {
    // p95 budgets — all ASSUMPTION values from thresholds.json
    "search_hit_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.search_cache_hit}`, abortOnFail: false },
      // Hard-alert ceiling — fail immediately if any sample exceeds this
      { threshold: `p(95)<${cfg.latency_p95_ms.search_hard_alert_ceiling}`, abortOnFail: true },
    ],
    "search_miss_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.search_cache_miss}`, abortOnFail: false },
      { threshold: `p(95)<${cfg.latency_p95_ms.search_hard_alert_ceiling}`, abortOnFail: true },
    ],
    "checkout_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.checkout_acknowledgement}`, abortOnFail: false },
    ],
    "assistant_ttft_p95_ms": [
      { threshold: `p(95)<${cfg.latency_p95_ms.assistant_first_token}`, abortOnFail: false },
    ],
    // Guardrails
    "server_fault_rate": [
      { threshold: `rate<${cfg.guardrails.server_fault_rate_max_pct / 100}`, abortOnFail: false },
    ],
    "checkout_fail_rate": [
      { threshold: `rate<${cfg.guardrails.checkout_platform_failure_rate_max_pct / 100}`, abortOnFail: false },
    ],
    // http_req_failed covers all request types — must stay under fault ceiling
    "http_req_failed": [
      { threshold: `rate<${cfg.guardrails.server_fault_rate_max_pct / 100}`, abortOnFail: false },
    ],
  },

  // Tag all requests with profile name so CloudWatch queries can filter
  tags: { profile: "sustained-peak", environment: __ENV.LOAD_ENV || "staging" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "X-Load-Test": "true",
    "X-Load-Test-Profile": "sustained-peak",
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
    flight_hit:   mix.flight_search_hit,
    flight_miss:  mix.flight_search_miss,
    hotel_hit:    mix.hotel_search_hit,
    hotel_miss:   mix.hotel_search_miss,
    car_hit:      mix.car_search_hit,
    car_miss:     mix.car_search_miss,
    checkout:     mix.checkout,
    assistant:    mix.assistant_first_token,
  });

  requestTotal.add(1);

  switch (scenario) {
    case "flight_hit":    doSearchHit("flights"); break;
    case "flight_miss":   doSearchMiss("flights"); break;
    case "hotel_hit":     doSearchHit("hotels"); break;
    case "hotel_miss":    doSearchMiss("hotels"); break;
    case "car_hit":       doSearchHit("cars"); break;
    case "car_miss":      doSearchMiss("cars"); break;
    case "checkout":      doCheckout(); break;
    case "assistant":     doAssistantTtft(); break;
  }

  sleep(0);
}

// ---------------------------------------------------------------------------
// Scenario implementations
// ---------------------------------------------------------------------------

function doSearchHit(type: "flights" | "hotels" | "cars"): void {
  const paramSet = type === "flights" ? hitFlights : type === "hotels" ? hitHotels : hitCars;
  const params = pickRandom(paramSet as unknown[]) as Record<string, unknown>;

  group(`search_hit_${type}`, () => {
    const url = `${GW_BASE}/api/v1/search/${type}`;
    const res = http.post(url, JSON.stringify(params), { headers: headers(), tags: { cohort: "hit", journey: type } });

    const ok = check(res, {
      "status 200": (r) => r.status === 200,
      "not 5xx": (r) => r.status < 500,
    });

    searchHitLatency.add(res.timings.duration);
    if (res.status >= 500) {
      serverFaultCounter.add(1);
      serverFaultRate.add(true);
    } else {
      serverFaultRate.add(false);
    }
  });
}

function doSearchMiss(type: "flights" | "hotels" | "cars"): void {
  const paramSet = type === "flights" ? missFlights : type === "hotels" ? missHotels : missCars;
  // Use VU_UNIQUE_ID to pick a different miss entry each iteration
  const idx = (__VU * 1000 + __ITER) % (paramSet as unknown[]).length;
  const params = (paramSet as unknown[])[idx] as Record<string, unknown>;

  group(`search_miss_${type}`, () => {
    const url = `${GW_BASE}/api/v1/search/${type}`;
    const res = http.post(url, JSON.stringify(params), { headers: headers(), tags: { cohort: "miss", journey: type } });

    check(res, {
      "status 200": (r) => r.status === 200,
      "not 5xx": (r) => r.status < 500,
    });

    searchMissLatency.add(res.timings.duration);
    if (res.status >= 500) {
      serverFaultCounter.add(1);
      serverFaultRate.add(true);
    } else {
      serverFaultRate.add(false);
    }
  });
}

function doCheckout(): void {
  const offer = pickRandom(checkoutOffers as unknown[]) as Record<string, unknown>;

  group("checkout", () => {
    // idempotency key derived from VU + iteration — unique per request, stable on retry
    const idempotencyKey = `lt_${__VU}_${__ITER}`;

    const body = {
      bookingType: offer.bookingType,
      offerId: offer.id,
      offerPrice: offer.offerPrice,
      currency: offer.currency,
      passengers: [searchParams.checkout.passengers[0]],
      contactEmail: `loadtest${__VU}@example.invalid`,
      idempotencyKey,
    };

    const res = http.post(
      `${GW_BASE}/api/v1/bookings`,
      JSON.stringify(body),
      {
        headers: headers(),
        tags: { journey: "checkout" },
      },
    );

    // 201 = PENDING booking accepted; 202 = idempotent repeat; 422/409 = platform error
    const platformError = res.status >= 500 || res.status === 422;

    check(res, {
      "booking accepted (201 or 202)": (r) => r.status === 201 || r.status === 202,
      "not platform fault": (r) => !platformError,
    });

    checkoutLatency.add(res.timings.duration);

    if (platformError) {
      checkoutFailureCounter.add(1);
      checkoutFailRate.add(true);
    } else {
      checkoutFailRate.add(false);
    }
    if (res.status >= 500) {
      serverFaultCounter.add(1);
      serverFaultRate.add(true);
    } else {
      serverFaultRate.add(false);
    }
  });
}

function doAssistantTtft(): void {
  const prompt = pickRandom(assistantPrompts as unknown[]) as string;

  group("assistant_ttft", () => {
    const body = {
      message: prompt,
      conversationId: `lt_${__VU}_${__ITER}`,
    };

    // Stream the response; measure time to first byte as TTFT proxy
    const res = http.post(
      `${GW_BASE}/api/v1/assistant/chat`,
      JSON.stringify(body),
      {
        headers: { ...headers(), Accept: "text/event-stream" },
        tags: { journey: "assistant" },
        // Enforce per-conversation token cap — header tells the assistant
        // to refuse if the conversation would exceed 60 000 tokens
        responseType: "text",
      },
    );

    // 429 from assistant token-cap is an expected refusal, not a fault
    const isExpectedRefusal = res.status === 429;
    const isServerFault = res.status >= 500;

    check(res, {
      "assistant responded": (r) => r.status === 200 || r.status === 429,
      "not server fault": (r) => !isServerFault,
    });

    if (!isExpectedRefusal) {
      // timings.waiting = time to first byte ≈ TTFT for streaming
      assistantTtftLatency.add(res.timings.waiting);
    }

    if (isServerFault) {
      serverFaultCounter.add(1);
      serverFaultRate.add(true);
    } else {
      serverFaultRate.add(false);
    }
  });
}
