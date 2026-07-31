import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for api-gateway.
 *
 * The gateway verifies RS256 JWTs from auth-service and consults a Redis
 * jti denylist for revocation. Both require runtime-injected credentials.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'JWT_PUBLIC_KEY',
    description:
      'RS256 public key PEM (SPKI) used to verify inbound access tokens. ' +
      'Must match the key currently served by auth-service KeyProvider.',
    minLength: 50,
  },
  {
    envVar: 'REDIS_URL',
    description:
      'Redis connection URL for the jti denylist (ElastiCache endpoint). ' +
      'Used for logout revocation and refresh-reuse detection.',
    minLength: 10,
  },
];
