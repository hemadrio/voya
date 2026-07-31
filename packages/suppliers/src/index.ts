// Egress policy — allow-list and pre-flight validation
export type { AllowedDestination } from './egress/egressPolicy.js';
export {
  EgressDeniedError,
  ALLOWED_DESTINATIONS,
  assertAllowedDestination,
} from './egress/egressPolicy.js';

// IP range validators
export { isBlockedIPv4, isBlockedIPv6, isBlockedAddress } from './egress/ipRanges.js';

// Circuit breaker
export type { BreakerState, CircuitBreakerOptions } from './egress/circuitBreaker.js';
export { CircuitBreaker } from './egress/circuitBreaker.js';

// Hardened HTTP client factory
export type {
  DnsEntry,
  DnsLookupFn,
  HardenedResponse,
  HardenedRequestOptions,
  HardenedClientOptions,
  HardenedFetch,
} from './egress/hardenedClient.js';
export { createHardenedClient } from './egress/hardenedClient.js';
