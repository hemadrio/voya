/**
 * OpenTelemetry bootstrap for notification-service consumer.
 * Must be imported before any other module in this service's entrypoint.
 */
import { initTracing } from '@travel/observability';

initTracing({
  serviceName: 'notification-service',
  serviceVersion: process.env['SERVICE_VERSION'],
  deploymentEnvironment: process.env['NODE_ENV'],
});
