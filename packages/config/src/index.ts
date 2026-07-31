/**
 * @travel/config — shared environment schema, database URL builder, and
 * connection-limit assertion for the travel platform.
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

export {
  baseEnvSchema,
  dbEnvSchema,
  redisEnvSchema,
  jwtPublicKeyEnvSchema,
  jwtSigningKeyEnvSchema,
  stripeEnvSchema,
  amadeusEnvSchema,
  rapidApiEnvSchema,
  anthropicEnvSchema,
  sqsConsumerEnvSchema,
  sesEnvSchema,
  googleOauthEnvSchema,
  apiGatewayEnvSchema,
  authServiceEnvSchema,
  userServiceEnvSchema,
  flightServiceEnvSchema,
  hotelServiceEnvSchema,
  carServiceEnvSchema,
  bookingServiceEnvSchema,
  paymentServiceEnvSchema,
  aiOrchestrationEnvSchema,
  notificationConsumerEnvSchema,
  platformEnvSchema,
  parseEnv,
} from "./env.js";
export type {
  BaseEnv,
  PlatformEnv,
  ParseEnvResult,
  ParseEnvSuccess,
  ParseEnvFailure,
} from "./env.js";

export { validateStartupEnv } from "./validate-startup.js";
export type { ValidateStartupOptions } from "./validate-startup.js";
