// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express before app.ts imports it.
import './tracing.js';
import { assertSecretsOrExit } from '@travel/observability';
import { REQUIRED_SECRETS } from './config/requiredSecrets.js';

if (process.env['NODE_ENV'] !== 'test') {
  assertSecretsOrExit(REQUIRED_SECRETS);
}

/**
 * payment-service entry point.
 *
 * Exports the ProcessedEventRepository for use by the Stripe webhook handler.
 * Exports RefundPort for the WO-048 saga compensation path so the
 * CheckoutSagaOrchestrator depends on an abstraction, not payment-service internals.
 */
export {
  recordProcessedEvent,
} from "./repositories/ProcessedEventRepository.js";
export type {
  ProcessedEventData,
  ProcessedEventDbClient,
  InsertOutcome,
} from "./repositories/ProcessedEventRepository.js";

// RefundPort — exported for WO-048 saga compensation (AC9 of WO-049)
export type {
  RefundPort,
  RefundResult,
  RefundServiceRequest,
} from "./domain/RefundService.js";
