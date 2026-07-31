import type { SecretDescriptor } from '@travel/observability';

/**
 * Required secrets for payment-service.
 *
 * payment-service calls the Stripe API to create PaymentIntents and verifies
 * incoming webhook HMAC signatures. An empty or placeholder Stripe webhook
 * secret causes signature verification to succeed unconditionally — this is a
 * critical security vulnerability that the validator must catch at boot.
 */
export const REQUIRED_SECRETS: ReadonlyArray<SecretDescriptor> = [
  {
    envVar: 'STRIPE_SECRET_KEY',
    description:
      'Stripe API secret key (sk_live_* or sk_test_* for non-production). ' +
      'Used to create PaymentIntents and perform refunds.',
    minLength: 20,
  },
  {
    envVar: 'STRIPE_WEBHOOK_SECRET',
    description:
      'Stripe webhook signing secret (whsec_*). ' +
      'Used to verify HMAC-SHA256 signatures on inbound webhook payloads. ' +
      'An empty string causes Stripe to skip signature verification.',
    minLength: 10,
  },
  {
    envVar: 'JWT_PUBLIC_KEY',
    description:
      'RS256 public key PEM used to verify inbound JWTs from the api-gateway.',
    minLength: 50,
  },
  {
    envVar: 'DATABASE_URL',
    description:
      'PostgreSQL connection string via RDS Proxy for the payments schema.',
    minLength: 20,
  },
];
