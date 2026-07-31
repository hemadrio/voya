import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for reporting-service.
 *
 * reporting-service generates platform analytics and operational reports.
 * It reads from the shared PostgreSQL database with a read-only service role.
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
      'PostgreSQL read-only connection string via RDS Proxy for the reporting schema.',
    minLength: 20,
  },
];
