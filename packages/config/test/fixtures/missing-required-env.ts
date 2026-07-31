/**
 * Missing-required-variable fixtures.
 * Each fixture omits one or more required variables that the schema must reject.
 */

/** auth-service env with DATABASE_URL omitted */
export const missingDatabaseUrlEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "info",
  JWT_SECRET:
    "dev-jwt-signing-key-that-is-long-enough-for-validation-purposes-only",
  // DATABASE_URL deliberately absent
};

/** payment-service env with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET omitted */
export const missingStripeKeysEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3007",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://payment_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xHn/ygWep\n-----END PUBLIC KEY-----",
  // STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET deliberately absent
};

/** api-gateway env with REDIS_URL omitted */
export const missingRedisUrlEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3000",
  LOG_LEVEL: "info",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xHn/ygWep\n-----END PUBLIC KEY-----",
  // REDIS_URL deliberately absent
};
