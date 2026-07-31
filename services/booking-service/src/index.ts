// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express before app.ts imports it.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

/**
 * booking-service (saga orchestrator) — placeholder entry point.
 *
 * This WO-001 scaffold exists only to prove that @travel/contracts resolves
 * through the pnpm workspace and validates a real payload from a consuming
 * service (see test/contracts.smoke.test.ts). The full Express service,
 * Prisma models, and saga orchestration are delivered by later booking
 * epics and are out of scope here.
 */
export {};
