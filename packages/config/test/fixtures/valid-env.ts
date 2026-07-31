/**
 * Valid environment fixture — all required variables present with safe values.
 * Used by env.test.ts to assert that parseEnv and validateStartupEnv succeed.
 * Never contains real credentials.
 */

export const validAuthEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://auth_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable",
  JWT_SECRET:
    "dev-jwt-signing-key-that-is-long-enough-for-validation-purposes-only",
};

export const validPaymentEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3007",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://payment_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5&pool_timeout=10&sslmode=disable",
  STRIPE_SECRET_KEY: "sk_test_51_dev_only_not_a_real_key_abc123",
  STRIPE_WEBHOOK_SECRET: "whsec_dev_only_not_real_abc123",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xHn/ygWep\n-----END PUBLIC KEY-----",
};

export const validApiGatewayEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3000",
  LOG_LEVEL: "info",
  REDIS_URL: "redis://localhost:6379",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xHn/ygWep\n-----END PUBLIC KEY-----",
};
