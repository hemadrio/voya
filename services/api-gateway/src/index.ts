// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express before app.ts imports it.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

export { createApp } from './app.js';
export type { GatewayOptions } from './app.js';
