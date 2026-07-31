// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// amqplib and AWS SDK before any other imports.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

export { startNotificationConsumer } from './consumer.js';
export type {
  NotificationConsumerOptions,
  NotificationDispatcher,
} from './consumer.js';

export { NotificationDispatcher as NotificationDispatcherImpl } from './domain/NotificationDispatcher.js';
export type { NotificationDispatcherOptions } from './domain/NotificationDispatcher.js';

export { IdempotencyGuard } from './domain/IdempotencyGuard.js';
export type { RedisClient, GuardResult } from './domain/IdempotencyGuard.js';

export { SesEmailAdapter } from './adapters/SesEmailAdapter.js';
export type { EmailPort, SesAdapterConfig, EmailSendRequest } from './adapters/SesEmailAdapter.js';

export { NotificationProcessedEventRepository } from './repositories/NotificationProcessedEventRepository.js';
export type { NotificationPrismaClient } from './repositories/NotificationProcessedEventRepository.js';

export { SuppressionRepository, hashEmail } from './repositories/SuppressionRepository.js';
export type { SuppressionPrismaClient, SuppressionReason } from './repositories/SuppressionRepository.js';

export { buildNotificationHealthHandlers } from './routes/health.js';
export type { NotificationHealthConfig } from './routes/health.js';

export {
  computeBackoffMs,
  isRetryable,
  MAX_DELIVERY_ATTEMPTS,
  DEFAULT_BACKOFF,
  SesThrottlingError,
  SesServiceUnavailableError,
  SesPermanentRejectionError,
  TransientDbError,
  TransientRedisError,
  PayloadValidationError,
  UnknownEventTypeError,
} from './domain/backoff.js';
