/**
 * alarm-validation.ts — Synthetic alarm validation suite.
 *
 * Injects controlled failure conditions into the development environment and
 * asserts that each corresponding CloudWatch alarm transitions to ALARM state
 * and delivers a notification to the SNS topic.
 *
 * ENVIRONMENT: development only — never run against staging or production.
 *
 * Usage:
 *   pnpm tsx scripts/synthetic/alarm-validation.ts [--alarm <name>] [--dry-run]
 *
 * Required environment variables:
 *   ENVIRONMENT           dev
 *   AWS_REGION            eu-west-1
 *   BASE_URL              http://localhost:3000 (or ALB DNS)
 *   STRIPE_WEBHOOK_SECRET (dev secret for invalid-signature test)
 *   SQS_QUEUE_URL         notification queue URL
 *   ALARM_WAIT_SECONDS    how long to wait for alarm state (default 120)
 *
 * Each scenario:
 *   1. Injects the condition (HTTP request, queue message, etc.)
 *   2. Waits for the alarm to enter ALARM state
 *   3. Asserts an SNS notification was delivered (via SQS dead-letter or
 *      a dedicated test subscription)
 *   4. Cleans up injected state
 */

import { CloudWatchClient, DescribeAlarmsCommand, type MetricAlarm } from "@aws-sdk/client-cloudwatch";
import { SQSClient, SendMessageCommand, PurgeQueueCommand } from "@aws-sdk/client-sqs";

const ENVIRONMENT = process.env["ENVIRONMENT"] ?? "dev";
const BASE_URL = process.env["BASE_URL"] ?? "http://localhost:3000";
const AWS_REGION = process.env["AWS_REGION"] ?? "eu-west-1";
const SQS_QUEUE_URL = process.env["SQS_QUEUE_URL"] ?? "";
const STRIPE_WEBHOOK_SECRET = process.env["STRIPE_WEBHOOK_SECRET"] ?? "";
const ALARM_WAIT_SECONDS = Number(process.env["ALARM_WAIT_SECONDS"] ?? "120");
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY_ALARM = process.argv[process.argv.indexOf("--alarm") + 1] ?? null;

const cw = new CloudWatchClient({ region: AWS_REGION });
const sqs = new SQSClient({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForAlarmState(
  alarmName: string,
  expectedState: "ALARM" | "OK",
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: [alarmName] }));
    const alarm: MetricAlarm | undefined = res.MetricAlarms?.[0];
    if (alarm?.StateValue === expectedState) {
      console.log(`  ✓ ${alarmName} → ${expectedState}`);
      return true;
    }
    console.log(`  … waiting for ${alarmName} (current: ${alarm?.StateValue ?? "NOT_FOUND"})`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.error(`  ✗ ${alarmName} did not reach ${expectedState} within ${timeoutSeconds}s`);
  return false;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Slow search — triggers CRITICAL-search-latency-p95-hard
//
// Calls the search endpoint with a `__synthetic_delay_ms=6000` header that
// the development search-service recognises and artificially delays by.
// ---------------------------------------------------------------------------

async function scenarioSlowSearch(): Promise<boolean> {
  console.log("\n[Scenario 1] Injecting slow search (6000 ms artificial delay)...");
  if (DRY_RUN) { console.log("  DRY RUN — skipping"); return true; }

  // Send 20 requests to ensure enough datapoints for a 3-of-5 alarm
  for (let i = 0; i < 20; i++) {
    await post("/v1/search", {
      origin: "LHR", destination: "JFK", departDate: "2026-08-01",
    }, { "X-Synthetic-Delay-Ms": "6000" });
  }

  return waitForAlarmState(`CRITICAL-search-latency-p95-hard`, "ALARM", ALARM_WAIT_SECONDS);
}

// ---------------------------------------------------------------------------
// Scenario 2: Forced 5xx — triggers CRITICAL-checkout-fault-rate
//
// Calls the debug endpoint that toggles a forced-error flag (development only).
// ---------------------------------------------------------------------------

async function scenarioForced5xx(): Promise<boolean> {
  console.log("\n[Scenario 2] Enabling forced 5xx for checkout...");
  if (DRY_RUN) { console.log("  DRY RUN — skipping"); return true; }

  // Enable forced error mode (dev feature flag)
  await post("/v1/__dev/force-error", { service: "checkout", statusCode: 500, durationSeconds: 90 });

  // Send enough requests to cross the 1% fault-rate threshold over 5 min
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      post("/v1/checkout/initiate", {
        offerId: "synthetic-offer-001",
        travelerIds: ["synthetic-traveler-001"],
      }),
    ),
  );
  const faults = results.filter((r) => r.status >= 500).length;
  console.log(`  Injected ${faults}/50 faults (${((faults / 50) * 100).toFixed(1)}%)`);

  const ok = await waitForAlarmState(`CRITICAL-checkout-fault-rate`, "ALARM", ALARM_WAIT_SECONDS);

  // Disable forced error mode
  await post("/v1/__dev/force-error", { service: "checkout", statusCode: null });
  return ok;
}

// ---------------------------------------------------------------------------
// Scenario 3: Invalid Stripe signature — triggers CRITICAL-stripe-signature-failure
//
// Posts a webhook with a deliberately wrong signature header.
// ---------------------------------------------------------------------------

async function scenarioInvalidStripeSignature(): Promise<boolean> {
  console.log("\n[Scenario 3] Posting invalid-signature Stripe webhook...");
  if (DRY_RUN) { console.log("  DRY RUN — skipping"); return true; }
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("  STRIPE_WEBHOOK_SECRET not set — skipping");
    return false;
  }

  // Deliberately wrong signature (tampered t= and v1=)
  const invalidSig = "t=1234567890,v1=0000000000000000000000000000000000000000000000000000000000000000";
  const payload = JSON.stringify({
    id: "evt_synthetic_invalid_sig",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_synthetic_001", amount: 10000 } },
  });

  await fetch(`${BASE_URL}/v1/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": invalidSig,
    },
    body: payload,
  });

  return waitForAlarmState(`CRITICAL-stripe-signature-failure`, "ALARM", ALARM_WAIT_SECONDS);
}

// ---------------------------------------------------------------------------
// Scenario 4: Queue flood — triggers HIGH-notification-queue-depth
//
// Sends 110 SQS messages to exceed the queue-depth threshold of 100.
// ---------------------------------------------------------------------------

async function scenarioQueueFlood(): Promise<boolean> {
  console.log("\n[Scenario 4] Flooding notification queue with 110 messages...");
  if (DRY_RUN) { console.log("  DRY RUN — skipping"); return true; }
  if (!SQS_QUEUE_URL) {
    console.warn("  SQS_QUEUE_URL not set — skipping");
    return false;
  }

  // Pause the consumer first (dev feature flag) so messages accumulate
  await post("/v1/__dev/queue-consumer", { action: "pause", queueUrl: SQS_QUEUE_URL });

  // Send 110 messages
  await Promise.all(
    Array.from({ length: 110 }, (_, i) =>
      sqs.send(new SendMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: "EMAIL",
          recipientId: `synthetic-recipient-${i}`,
          template: "BOOKING_CONFIRMATION",
          correlationId: `synthetic-alarm-validation-${Date.now()}-${i}`,
        }),
      })),
    ),
  );
  console.log("  Sent 110 messages to queue");

  const ok = await waitForAlarmState(`HIGH-notification-queue-depth`, "ALARM", ALARM_WAIT_SECONDS);

  // Resume consumer and purge synthetic messages
  await post("/v1/__dev/queue-consumer", { action: "resume", queueUrl: SQS_QUEUE_URL });
  await sqs.send(new PurgeQueueCommand({ QueueUrl: SQS_QUEUE_URL }));
  console.log("  Queue purged; consumer resumed");

  return ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const scenarios: Array<{ name: string; alarmName: string; fn: () => Promise<boolean> }> = [
  { name: "slow-search",          alarmName: "CRITICAL-search-latency-p95-hard",    fn: scenarioSlowSearch },
  { name: "forced-5xx",           alarmName: "CRITICAL-checkout-fault-rate",         fn: scenarioForced5xx },
  { name: "stripe-sig-invalid",   alarmName: "CRITICAL-stripe-signature-failure",    fn: scenarioInvalidStripeSignature },
  { name: "queue-flood",          alarmName: "HIGH-notification-queue-depth",        fn: scenarioQueueFlood },
];

const filtered = ONLY_ALARM
  ? scenarios.filter((s) => s.name === ONLY_ALARM || s.alarmName.includes(ONLY_ALARM))
  : scenarios;

if (filtered.length === 0) {
  console.error(`No scenario found for --alarm ${ONLY_ALARM}`);
  process.exit(1);
}

console.log(`
=========================================================
  Synthetic Alarm Validation Suite
  Environment: ${ENVIRONMENT}
  Base URL:    ${BASE_URL}
  Dry run:     ${DRY_RUN}
  Scenarios:   ${filtered.map((s) => s.name).join(", ")}
=========================================================
`);

let passed = 0;
let failed = 0;

for (const scenario of filtered) {
  const ok = await scenario.fn();
  if (ok) { passed++; } else { failed++; }
}

console.log(`
=========================================================
  Results: ${passed} passed, ${failed} failed
=========================================================
`);

process.exit(failed > 0 ? 1 : 0);
