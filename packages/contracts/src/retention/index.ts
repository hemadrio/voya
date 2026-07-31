export {
  DATA_CLASSIFICATION_VALUES,
  DataClassificationSchema,
  RETENTION_CONFIG_KEYS,
  RetentionConfigSchema,
} from "./classification.js";
export type {
  DataClassification,
  RetentionConfigKey,
  RetentionConfigEnvVar,
  RetentionConfig,
} from "./classification.js";

export {
  CLASSIFICATION_REGISTER,
  getEntriesForTable,
  getEntryById,
  getDsrExportEntries,
  getErasureExcludedEntries,
  getJsonSurfaceEntries,
} from "./register.js";
export type { RegisterEntry, ClassificationRegister, ErasureMethod } from "./register.js";
