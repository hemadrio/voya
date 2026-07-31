/**
 * OpenTelemetry bootstrap for ai-service.
 * Must be imported before any other module in this service's entrypoint.
 */
import { initTracing } from '@travel/observability';

initTracing({
  serviceName: 'ai-service',
  serviceVersion: process.env['SERVICE_VERSION'],
  deploymentEnvironment: process.env['NODE_ENV'],
  // AI service has a shorter latency budget: assistant first-token p95 = 2000 ms.
  latencyBudgetMs: 2_000,
});
