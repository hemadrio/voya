// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// amqplib and AWS SDK before consumer.ts imports them.
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
