// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// amqplib and AWS SDK before consumer.ts imports them.
import './tracing.js';
export { startNotificationConsumer } from './consumer.js';
export type {
  NotificationConsumerOptions,
  NotificationDispatcher,
} from './consumer.js';
