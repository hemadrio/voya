// Tracing bootstrap MUST be the first import.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

export {};
