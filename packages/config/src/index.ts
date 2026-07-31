/**
 * @travel/config — shared database URL builder and connection-limit assertion.
 *
 * Import this package in any service that needs to construct or validate a
 * PostgreSQL connection URL for RDS Proxy.
 */
export {
  buildDatabaseUrl,
  buildLocalDatabaseUrl,
  assertConnectionLimit,
  MAX_SERVICE_CONNECTION_LIMIT,
  MIGRATION_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
} from "./databaseUrl.js";
export type { BuildUrlOptions } from "./databaseUrl.js";
