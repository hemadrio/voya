export type { LogContext } from './context.js';
export { createLogger, createChildLogger } from './logger.js';
export type { CreateLoggerOptions } from './logger.js';

export {
  generateULID,
  isValidCorrelationId,
  getCorrelationId,
  getTraceId,
  injectHeaders,
  injectMessageAttributes,
  createCorrelationIdMiddleware,
} from './correlation.js';
export type {
  MessageAttributes,
  CorrelationMiddlewareOptions,
} from './correlation.js';

export {
  initTracing,
  shutdownTracing,
  AlwaysRecordSampler,
  ErrorAndSlowSpanProcessor,
  _resetTracingSingleton,
} from './tracing.js';
export type { TracingOptions } from './tracing.js';

export {
  recordSupplierCall,
  recordBookingTransition,
  recordAssistantBudget,
} from './spanAttributes.js';
export type { SupplierOutcome, BookingState } from './spanAttributes.js';
