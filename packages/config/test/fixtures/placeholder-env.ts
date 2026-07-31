/**
 * Placeholder-value fixtures.
 *
 * These environments pass schema validation (the shape is correct) but contain
 * placeholder values that should:
 *   - Emit a warning in NODE_ENV=development (and continue).
 *   - Hard-fail in any other NODE_ENV.
 *
 * Tests use these fixtures to assert validateStartupEnv behaviour in both modes.
 */

/** auth-service with JWT_SECRET set to a placeholder blocklist value */
export const placeholderJwtSecretEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://auth_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5",
  JWT_SECRET: "dev-secret-change-me", // exact entry in PLACEHOLDER_BLOCKLIST
};

/** payment-service with STRIPE_SECRET_KEY set to a placeholder */
export const placeholderStripeKeyEnv: Record<string, string> = {
  NODE_ENV: "production",
  PORT: "3007",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://payment_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5",
  STRIPE_SECRET_KEY: "change-me", // in PLACEHOLDER_BLOCKLIST
  STRIPE_WEBHOOK_SECRET: "whsec_dev_only_not_real_abc123",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xHn/ygWep\n-----END PUBLIC KEY-----",
};

/** Same as placeholderStripeKeyEnv but NODE_ENV=development (should warn, not fail) */
export const placeholderStripeKeyDevEnv: Record<string, string> = {
  ...placeholderStripeKeyEnv,
  NODE_ENV: "development",
};
