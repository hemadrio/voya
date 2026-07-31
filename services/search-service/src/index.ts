// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express and supplier HTTP clients before app.ts imports them.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

export { createApp } from './app.js';
