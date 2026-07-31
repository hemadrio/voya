import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for car-service.
 *
 * RapidAPI credentials are backed by AWS Secrets Manager. The service
 * refuses to start if either value is absent or matches a known placeholder
 * (enforced by the Phase-0 assertSecretsOrExit validator from WO-012).
 *
 * RAPIDAPI_KEY is shared with hotel-service (same RapidAPI account).
 * RAPIDAPI_CAR_HOST is provider-specific (e.g. "booking-com15.p.rapidapi.com").
 *
 * See services/car-service/README.md for the provider selection rationale.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'RAPIDAPI_KEY',
    description:
      'Shared RapidAPI API key for car rental search. Sent as x-rapidapi-key header. Never logged.',
    allowEmptyInDev: true,
  },
  {
    envVar: 'RAPIDAPI_CAR_HOST',
    description:
      'RapidAPI provider hostname for car rental search (e.g. booking-com15.p.rapidapi.com). Sent as x-rapidapi-host header.',
    allowEmptyInDev: true,
  },
];

/**
 * Wildcard root hostname for RapidAPI providers.
 * All provider-specific subdomains (*.p.rapidapi.com) are pre-approved in
 * packages/suppliers ALLOWED_DESTINATIONS (allowWildcardSubdomains: true).
 */
export const RAPIDAPI_EGRESS_HOST_SUFFIX = 'p.rapidapi.com';
