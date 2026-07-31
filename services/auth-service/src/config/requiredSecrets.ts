import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for auth-service.
 *
 * auth-service signs JWTs with an RS256 private key and verifies Argon2id
 * password hashes. Both must be injected by the ECS task definition at
 * runtime via AWS Secrets Manager — never baked into the image.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'JWT_SECRET',
    description:
      'JWT signing key (RS256 private key PEM or symmetric HMAC secret). ' +
      'Minimum 32 bytes to meet entropy requirements.',
    minLength: 32,
  },
  {
    envVar: 'DATABASE_URL',
    description:
      'PostgreSQL connection string via RDS Proxy. ' +
      'Contains the service-role password — must not be a placeholder.',
    minLength: 20,
  },
];
