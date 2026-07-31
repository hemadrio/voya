export {
  deriveAccountIdentityPurgeAfter,
  deriveSessionPurgeAfter,
  deriveOneTimeTokenPurgeAfter,
  deriveBookingPurgeAfter,
  deriveTravelerIdentityPurgeAfter,
  deriveItineraryPurgeAfter,
  derivePreferencePurgeAfter,
  deriveConversationPurgeAfter,
  deriveAuditPurgeAfter,
} from "./derivePurgeAfter.js";

export { loadRetentionConfig, buildRetentionConfig } from "./retentionConfig.js";

export {
  createPartitionMaintenance,
  type PartitionMaintenance,
  type PartitionMaintenanceOptions,
  type PartitionMaintenanceReport,
  type PartitionDbClient,
  type PartitionMaintenanceLogger,
} from "./PartitionMaintenance.js";

// Purge worker types
export type {
  PurgeClock,
  PurgeRepositoryPort,
  ErasureCandidate,
  PurgeRunRecord,
  QuarantineEntry,
  CategoryPurgeStrategy,
  StrategyExecuteOptions,
  StrategyResult,
  PurgeMetrics,
  PurgeLogger,
} from "./types.js";

export { SystemPurgeClock } from "./types.js";

// Purge strategies
export { PhysicalDeleteStrategy } from "./strategies/PhysicalDeleteStrategy.js";
export { CryptoEraseStrategy } from "./strategies/CryptoEraseStrategy.js";
export { PseudonymiseActorStrategy } from "./strategies/PseudonymiseActorStrategy.js";
export { ConversationSweepStrategy } from "./strategies/ConversationSweepStrategy.js";

// Orchestrator
export {
  PurgeOrchestrator,
  type PurgeOrchestratorConfig,
  type OrchestratorRunResult,
  type CategoryRunResult,
  type CategoryStatus,
} from "./PurgeOrchestrator.js";

// Metrics
export { createPurgeMetrics, SpyPurgeMetrics } from "./metrics.js";
