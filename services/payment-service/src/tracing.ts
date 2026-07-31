/**
 * OpenTelemetry bootstrap for payment-service.
 * Must be imported before any other module in this service's entrypoint.
 */
import { initTracing } from '@travel/observability';

initTracing({
  serviceName: 'payment-service',
  serviceVersion: process.env['SERVICE_VERSION'],
  deploymentEnvironment: process.env['NODE_ENV'],
});
