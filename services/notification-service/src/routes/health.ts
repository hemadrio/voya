/**
 * Deep health check route builder for notification-service.
 *
 * Probes: postgres (required), redis (required — outage blocks delivery
 * correctness), queue (required — consumer cannot receive work), secrets
 * (required — missing config is a startup error).
 *
 * Redis is required here (unlike search services) because a Redis outage
 * silently degrades to DB-only path; the readiness check must alert before
 * the backlog grows.
 */

import {
  createHealthCheck,
  createPrismaProbe,
  createRedisProbe,
  createQueueProbe,
  createSecretsProbe,
  type HealthHandlers,
  type PrismaHealthClient,
  type RedisHealthClient,
  type QueueHealthClient,
} from '@travel/observability';

export interface NotificationHealthConfig {
  readonly prisma: PrismaHealthClient;
  readonly redis: RedisHealthClient;
  readonly queue: QueueHealthClient;
  readonly secretsValid: boolean;
}

export function buildNotificationHealthHandlers(
  config: NotificationHealthConfig,
): HealthHandlers {
  return createHealthCheck({
    serviceName: 'notification-service',
    probes: [
      createPrismaProbe(config.prisma, { name: 'postgres', required: true }),
      createRedisProbe(config.redis, { name: 'redis', required: true }),
      createQueueProbe(config.queue, { name: 'queue', required: true }),
      createSecretsProbe(config.secretsValid),
    ],
  });
}
