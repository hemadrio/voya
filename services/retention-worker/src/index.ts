/**
 * Retention purge worker entry point.
 *
 * Usage:
 *   node dist/index.js               # dry-run (default, safe)
 *   node dist/index.js --apply       # live purge
 *
 * Exit codes:
 *   0  — success (or dry-run complete with no failures)
 *   1  — one or more category failures (never fail open — policy A10)
 *   2  — configuration validation error (missing retention period key)
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  loadRetentionConfig,
  PhysicalDeleteStrategy,
  CryptoEraseStrategy,
  PseudonymiseActorStrategy,
  ConversationSweepStrategy,
  PurgeOrchestrator,
  SystemPurgeClock,
  createPurgeMetrics,
  type CategoryPurgeStrategy,
} from "@travel/retention";
import { KmsEnvelopeCipher } from "@travel/crypto";
import { CLASSIFICATION_REGISTER } from "@travel/contracts/retention";
import { buildPrismaRepository } from "./buildPrismaRepository.js";
import { buildLogger } from "./buildLogger.js";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const { values: argv } = parseArgs({
  args: process.argv.slice(2),
  options: { apply: { type: "boolean", default: false } },
  strict: false,
});

const dryRun = !(argv["apply"] as boolean);

// ---------------------------------------------------------------------------
// Configuration validation (refuse to start on missing keys — policy A10)
// ---------------------------------------------------------------------------

let retentionConfig: ReturnType<typeof loadRetentionConfig>;
try {
  retentionConfig = loadRetentionConfig();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[retention-worker] CONFIG ERROR: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Build dependencies
// ---------------------------------------------------------------------------

const correlationId = randomUUID();
const logger = buildLogger();
const repo = await buildPrismaRepository(logger);
const metrics = createPurgeMetrics();
const clock = new SystemPurgeClock();

// ---------------------------------------------------------------------------
// Wire strategies
// ---------------------------------------------------------------------------

const strategies = new Map<string, CategoryPurgeStrategy>([
  ["physical_delete", new PhysicalDeleteStrategy(repo, logger)],
  ["crypto_erasure", new CryptoEraseStrategy(repo, /* cipher injected from env */ buildCipher(), logger)],
  ["pseudonymisation", new PseudonymiseActorStrategy(repo, logger)],
  ["conversation_sweep", new ConversationSweepStrategy(repo, retentionConfig, logger)],
]);

// ---------------------------------------------------------------------------
// Build and run orchestrator
// ---------------------------------------------------------------------------

logger.info(
  { correlationId, dryRun, nodeEnv: process.env["NODE_ENV"] },
  "retention-worker: starting",
);

const orchestrator = new PurgeOrchestrator(
  CLASSIFICATION_REGISTER,
  strategies,
  repo,
  clock,
  metrics,
  logger,
  {
    batchSize: parseInt(process.env["PURGE_BATCH_SIZE"] ?? "500", 10),
    interBatchPauseMs: parseInt(process.env["PURGE_INTER_BATCH_PAUSE_MS"] ?? "250", 10),
    maxBatchesPerCategory: parseInt(process.env["PURGE_MAX_BATCHES_PER_CATEGORY"] ?? "1000", 10),
    loadThreshold: parseFloat(process.env["PURGE_LOAD_THRESHOLD"] ?? "0.7"),
    leaseTtlSeconds: parseInt(process.env["PURGE_LEASE_TTL_SECONDS"] ?? "3600", 10),
  },
);

let exitCode = 0;
try {
  const result = await orchestrator.run({ dryRun, correlationId });

  const failureCount = result.categories.filter((c) => c.status === "failure").length;

  logger.info(
    {
      correlationId,
      dryRun: result.dryRun,
      totalCategories: result.categories.length,
      failures: failureCount,
      durationMs: result.finishedAt.getTime() - result.startedAt.getTime(),
    },
    "retention-worker: run complete",
  );

  if (result.hasFailures) {
    // Non-zero exit on any category failure (policy A10 — never fail open)
    exitCode = 1;
  }
} catch (err) {
  // Unexpected orchestrator-level failure — never fail open
  logger.error({ correlationId }, "retention-worker: orchestrator threw unexpectedly");
  exitCode = 1;
} finally {
  await repo.disconnect?.();
}

process.exit(exitCode);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCipher() {
  const keyArn = process.env["KMS_PURGE_KEY_ARN"];
  if (!keyArn) throw new Error("KMS_PURGE_KEY_ARN env var is required");
  return new KmsEnvelopeCipher({ keyArn });
}
