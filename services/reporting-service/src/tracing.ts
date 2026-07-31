/**
 * OpenTelemetry bootstrap for reporting-service.
 * Must be imported before any other module in this service's entrypoint.
 */
import { initTracing } from '@travel/observability';

initTracing({
  serviceName: 'reporting-service',
  serviceVersion: process.env['SERVICE_VERSION'],
  deploymentEnvironment: process.env['NODE_ENV'],
});
