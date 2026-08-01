/**
 * expirySweep.ts — Standalone ECS entrypoint for the PENDING booking expiry
 * sweep (WO-043).
 *
 * This file is NOT imported by the HTTP service (index.ts). It is a separate
 * container command invoked by EventBridge on the same Docker image:
 *
 *   command: ["node", "dist/jobs/expirySweep.js"]
 *
 * Running as a one-shot ECS task (not in-process cron) means:
 *   - No timer multiplied across service replicas.
 *   - A failed run exits non-zero and surfaces in CloudWatch / EventBridge.
 *   - The per-task DB connection is bounded by EXPIRY_SWEEP_BATCH_SIZE and
 *     the connection_limit=5 on RDS Proxy is respected.
 *
 * Configuration (all via environment variables):
 *   EXPIRY_SWEEP_BATCH_SIZE    - Max candidates per run (default: 200)
 *   EXPIRY_SWEEP_WINDOW_MINUTES- Minutes before a PENDING booking expires
 *                                (default: 30; here for documentation only —
 *                                the actual window is stored in expires_at at
 *                                booking create time)
 *   EXPIRY_SWEEP_MAX_BATCHES   - Max iterations before forced exit (default: 50)
 *   EXPIRY_SWEEP_FAILURE_THRESHOLD - Max failed items as fraction before
 *                                non-zero exit (default: 0.2 = 20%)
 *   DATABASE_URL               - Injected by ECS secrets
 *   QUEUE_DRIVER               - "sqs" | "rabbitmq"
 *   SQS_QUEUE_URL_PREFIX / AMQP_URL - injected by ECS
 */

import "./tracing.js";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { PrismaClient } from "@prisma/client";
import { BookingRepository } from "../repositories/BookingRepository.js";
import { BookingLifecycleService } from "../domain/BookingLifecycleService.js";
import { ExpirySweepService } from "../domain/ExpirySweepService.js";
import { createQueueAdapter } from "@travel/queue";
import { emitSweepMetrics } from "./sweepMetrics.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = Math.max(1, parseInt(process.env["EXPIRY_SWEEP_BATCH_SIZE"] ?? "200", 10));
const MAX_BATCHES = Math.max(1, parseInt(process.env["EXPIRY_SWEEP_MAX_BATCHES"] ?? "50", 10));
const FAILURE_THRESHOLD = parseFloat(process.env["EXPIRY_SWEEP_FAILURE_THRESHOLD"] ?? "0.2");

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "booking-service", job: "expiry-sweep" },
});

const correlationId = randomUUID();

async function main(): Promise<void> {
  log.info({ correlationId, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES }, "Expiry sweep started");

  const prisma = new PrismaClient({ log: [] });
  const repo = new BookingRepository(prisma as any);
  const lifecycleService = new BookingLifecycleService({ repository: repo, log });

  const queueDriver = process.env["QUEUE_DRIVER"] ?? "sqs";
  const queue = createQueueAdapter({
    driver: queueDriver as any,
    sqsQueueUrlPrefix: process.env["SQS_QUEUE_URL_PREFIX"],
    amqpUrl: process.env["AMQP_URL"],
  });

  const sweepService = new ExpirySweepService({
    lifecycleService,
    paymentStatus: repo,
    queue,
    log,
  });

  let totalCandidates = 0;
  let totalExpired = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const runStartMs = Date.now();

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const now = new Date();
    const candidates = await repo.findExpiredPendingCandidates(BATCH_SIZE, now);

    if (candidates.length === 0) {
      log.info({ correlationId, batch }, "Expiry sweep completed — no more candidates");
      break;
    }

    const result = await sweepService.processBatch(candidates, correlationId);

    totalCandidates += result.metrics.candidates;
    totalExpired += result.metrics.expired;
    totalSkipped += result.metrics.skipped;
    totalFailed += result.metrics.failed;

    log.info(
      { correlationId, batch, metrics: result.metrics },
      "Expiry sweep batch completed",
    );

    // Stop if we are clearly making no forward progress (all skipped/failed)
    if (result.metrics.expired === 0 && result.metrics.candidates > 0) {
      log.warn({ correlationId, batch }, "Expiry sweep made no progress in batch — stopping");
      break;
    }
  }

  const totalDurationMs = Date.now() - runStartMs;

  await emitSweepMetrics({
    candidates: totalCandidates,
    expired: totalExpired,
    skipped: totalSkipped,
    failed: totalFailed,
    durationMs: totalDurationMs,
  });

  log.info(
    {
      correlationId,
      totalCandidates,
      totalExpired,
      totalSkipped,
      totalFailed,
      totalDurationMs,
    },
    "Expiry sweep run finished",
  );

  await prisma.$disconnect();
  await queue.close();

  // Exit non-zero if failure ratio exceeds threshold
  if (totalCandidates > 0) {
    const failureRatio = totalFailed / totalCandidates;
    if (failureRatio > FAILURE_THRESHOLD) {
      log.error(
        { correlationId, failureRatio, threshold: FAILURE_THRESHOLD },
        "Expiry sweep failure ratio exceeded threshold",
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  log.error({ err, correlationId: "bootstrap" }, "Expiry sweep fatal error");
  process.exit(1);
});
