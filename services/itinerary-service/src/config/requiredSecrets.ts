import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for itinerary-service.
 *
 * itinerary-service composes and persists multi-leg trip plans. It verifies
 * JWTs from the gateway to establish the requesting traveler's identity.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'JWT_PUBLIC_KEY',
    description:
      'RS256 public key PEM used to verify inbound JWTs from the api-gateway.',
    minLength: 50,
  },
  {
    envVar: 'DATABASE_URL',
    description:
      'PostgreSQL connection string via RDS Proxy for the itineraries schema.',
    minLength: 20,
  },
];
