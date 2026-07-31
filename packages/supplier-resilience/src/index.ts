export type {
  BreakerConfig,
  BreakerMetrics,
  BreakerState,
  Clock,
  FanOutConfig,
  FanOutMetrics,
  FanOutResult,
  NormalisedOffer,
  ResilienceLogger,
  SupplierAdapter,
  SupplierCallOutcome,
  SupplierOutcomeEntry,
} from './types.js';

export {
  CircuitOpenError,
  DEFAULT_BREAKER_CONFIG,
  SystemClock,
  TimeoutError,
} from './types.js';

export { CircuitBreaker } from './CircuitBreaker.js';
export { BreakerRegistry } from './BreakerRegistry.js';
export { SupplierFanOutExecutor } from './SupplierFanOutExecutor.js';

export {
  SpyBreakerMetrics,
  SpyFanOutMetrics,
  createOtelBreakerMetrics,
  createOtelFanOutMetrics,
} from './metrics.js';
