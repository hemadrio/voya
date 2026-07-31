import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for user-service.
 *
 * user-service manages traveler profiles and preferences. It verifies JWTs
 * from the gateway and reads/writes user records to PostgreSQL.
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
      'PostgreSQL connection string via RDS Proxy for the users schema.',
    minLength: 20,
  },
];
