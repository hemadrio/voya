/**
 * ConversationSweepStrategy — purges conversation history on a rolling window.
 *
 * Handles both the Redis TTL surface (via the repository's deleteConversationKeys)
 * and the durable conversation store (physical delete).
 *
 * The conversationDays config sets the rolling window; messages older than
 * now - conversationDays are expired.
 *
 * Redis unavailability: if Redis sweep fails, the durable sweep still runs
 * and a separate alarm is raised. The strategy records a partial status.
 */

import type {
  CategoryPurgeStrategy,
  PurgeRepositoryPort,
  PurgeLogger,
  StrategyExecuteOptions,
  StrategyResult,
} from "../types.js";
import type { RegisterEntry } from "@travel/contracts/retention";
import type { RetentionConfig } from "@travel/contracts/retention";

export class ConversationSweepStrategy implements CategoryPurgeStrategy {
  readonly name = "conversation_sweep";

  constructor(
    private readonly repo: PurgeRepositoryPort,
    private readonly config: Pick<RetentionConfig, "conversationDays">,
    private readonly logger: PurgeLogger,
  ) {}

  async execute(
    entry: RegisterEntry,
    options: StrategyExecuteOptions,
  ): Promise<StrategyResult> {
    const { now, batchSize, dryRun, correlationId } = options;

    // Compute the cutoff: messages older than this are expired
    const cutoff = new Date(now.getTime() - this.config.conversationDays * 86_400_000);

    const examined = await this.repo.countExpired(entry.table, now);

    if (dryRun) {
      this.logger.info(
        {
          correlationId,
          category: entry.category,
          entryId: entry.id,
          table: entry.table,
          examined,
          cutoff: cutoff.toISOString(),
          dryRun: true,
        },
        "purge.dry_run: would sweep conversation history",
      );
      return { examined, purged: 0, keysDestroyed: 0, status: "skipped" };
    }

    let redisDeleted = 0;
    let redisError = false;

    // --- Redis TTL sweep ---
    try {
      redisDeleted = await this.repo.deleteConversationKeys(cutoff, batchSize);
      this.logger.info(
        { correlationId, category: entry.category, redisDeleted },
        "purge.conversation_sweep: redis keys deleted",
      );
    } catch (err) {
      // Redis failure: log alarm-worthy event, continue with durable sweep
      // Do not log error content (BR-13 — no stack traces or provider payloads)
      this.logger.error(
        { correlationId, category: entry.category, alertable: true },
        "purge.conversation_sweep: redis sweep failed — alarm raised, durable sweep continues",
      );
      redisError = true;
    }

    // --- Durable store sweep (physical delete) ---
    let durableDeleted = 0;
    const durableDeleted2 = await this.repo.deleteBatch(entry.table, batchSize, now);
    durableDeleted = durableDeleted2;

    this.logger.info(
      { correlationId, category: entry.category, durableDeleted },
      "purge.conversation_sweep: durable rows deleted",
    );

    const totalPurged = redisDeleted + durableDeleted;
    const status = redisError ? "partial" : "success";

    return { examined, purged: totalPurged, keysDestroyed: 0, status };
  }
}
