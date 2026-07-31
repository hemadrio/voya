// Tracing bootstrap MUST be the first import so auto-instrumentation patches
// Express before app.ts imports it.
import './tracing.js';

/**
 * payment-service entry point.
 *
 * Exports the ProcessedEventRepository for use by the Stripe webhook handler.
 * The full Express service and Stripe integration are delivered by later
 * payment epics and are out of scope for WO-072.
 */
export {
  recordProcessedEvent,
} from "./repositories/ProcessedEventRepository.js";
export type {
  ProcessedEventData,
  ProcessedEventDbClient,
  InsertOutcome,
} from "./repositories/ProcessedEventRepository.js";
