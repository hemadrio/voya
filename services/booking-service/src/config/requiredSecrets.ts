import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for booking-service (saga orchestrator).
 *
 * booking-service verifies JWTs forwarded by the api-gateway and holds
 * offer snapshots in PostgreSQL — both secrets are required at boot.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'JWT_PUBLIC_KEY',
    description:
      'RS256 public key PEM used to verify inbound JWTs from the api-gateway. ' +
      'Must match the signing key held by auth-service.',
    minLength: 50,
  },
  {
    envVar: 'DATABASE_URL',
    description:
      'PostgreSQL connection string via RDS Proxy for the booking schema.',
    minLength: 20,
  },
  {
    envVar: 'QUEUE_DRIVER',
    description:
      'Queue adapter driver to use. Must be "rabbitmq" (local Docker Compose) or "sqs" (production). ' +
      'Controls which @travel/queue adapter is instantiated at startup. ' +
      'Missing or unknown value causes a non-zero exit before accepting traffic.',
    minLength: 3,
  },
];
