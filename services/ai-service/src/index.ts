// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express and Claude SDK client before tools.ts imports them.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

export * from './tools.js';
