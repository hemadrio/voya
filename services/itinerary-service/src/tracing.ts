/**
 * OpenTelemetry bootstrap for itinerary-service.
 * Must be imported before any other module in this service's entrypoint.
 */
import { initTracing } from '@travel/observability';

initTracing({
  serviceName: 'itinerary-service',
  serviceVersion: process.env['SERVICE_VERSION'],
  deploymentEnvironment: process.env['NODE_ENV'],
});
