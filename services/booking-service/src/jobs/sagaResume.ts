/**
 * sagaResume.ts — Standalone ECS entrypoint for the checkout saga resume job.
 *
 * Re-enqueues RUNNING sagas whose updated_at is stale (older than
 * SAGA_STALE_MINUTES). Stale sagas indicate the orchestrator crashed between
 * steps. A separate saga worker picks up the re-enqueued message and calls
 * CheckoutSagaOrchestrator.resume().
 *
 * Runs as a one-shot ECS task (EventBridge-scheduled), not as an in-process
 * timer, so a crash exits non-zero and surfaces in CloudWatch.
 *
 * Configuration (environment variables):
 *   SAGA_STALE_MINUTES     - Minutes before a RUNNING saga is considered stale (default: 5)
 *   SAGA_RESUME_BATCH_SIZE - Max sagas per run (default: 50)
 *   DATABASE_URL           - Injected by ECS secrets
 *   QUEUE_DRIVER           - "sqs" | "rabbitmq"
 *   SQS_QUEUE_URL_PREFIX / AMQP_URL
 */

import pino from "pino";
import { PrismaClient } from "@prisma/client";
import { createQueueAdapter } from "@travel/queue";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STALE_MINUTES = Math.max(1, parseInt(process.env["SAGA_STALE_MINUTES"] ?? "5", 10));
const BATCH_SIZE = Math.max(1, parseInt(process.env["SAGA_RESUME_BATCH_SIZE"] ?? "50", 10));
const QUEUE_TOPIC = "checkout.saga.resume";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const log = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  base: { service: "booking-service", job: "saga-resume" },
});

const correlationId = randomUUID();

// ---------------------------------------------------------------------------
// In-memory saga repository for the resume job
// (the full Prisma-backed repository is wired in the service runtime)
// ---------------------------------------------------------------------------

interface StaleSagaRow {
  id: string;
  bookingId: string;
  status: string;
  updatedAt: Date;
}

async function findStaleSagas(prisma: PrismaClient, staleBefore: Date): Promise<StaleSagaRow[]> {
  // Use raw query to avoid Prisma generated types until migration runs
  const rows = await prisma.$queryRaw<StaleSagaRow[]>`
    SELECT id, booking_id as "bookingId", status, updated_at as "updatedAt"
    FROM checkout_sagas
    WHERE status = 'RUNNING'
      AND updated_at < ${staleBefore}
    ORDER BY updated_at ASC
    LIMIT ${BATCH_SIZE}
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_MINUTES * 60 * 1000);

  log.info({ correlationId, staleBeforeIso: staleBefore.toISOString() }, "Saga resume job started");

  const prisma = new PrismaClient({ log: [] });
  const queueDriver = process.env["QUEUE_DRIVER"] ?? "sqs";
  const queue = createQueueAdapter({
    driver: queueDriver as "sqs" | "rabbitmq",
    sqsQueueUrlPrefix: process.env["SQS_QUEUE_URL_PREFIX"],
    amqpUrl: process.env["AMQP_URL"],
  });

  let resumedCount = 0;
  let errorCount = 0;

  try {
    const staleSagas = await findStaleSagas(prisma, staleBefore);

    log.info({ correlationId, count: staleSagas.length }, "Found stale sagas");

    for (const saga of staleSagas) {
      try {
        await queue.publish(
          QUEUE_TOPIC,
          {
            id: randomUUID(),
            type: "checkout.saga.resume",
            version: "1",
            correlationId,
            payload: { sagaId: saga.id, bookingId: saga.bookingId },
            publishedAt: new Date().toISOString(),
          },
        );
        resumedCount++;
        log.info({ sagaId: saga.id, bookingId: saga.bookingId }, "Re-enqueued stale saga");
      } catch (err) {
        errorCount++;
        log.error(
          { sagaId: saga.id, error: err instanceof Error ? err.message : String(err) },
          "Failed to re-enqueue saga",
        );
      }
    }

    log.info({ correlationId, resumedCount, errorCount }, "Saga resume job complete");
  } finally {
    await prisma.$disconnect();
    await queue.close();
  }

  if (errorCount > 0) {
    log.error({ errorCount }, "Some sagas could not be re-enqueued");
    process.exit(1);
  }
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, "Saga resume job fatal error");
  process.exit(1);
});
