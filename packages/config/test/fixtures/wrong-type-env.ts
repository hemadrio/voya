/**
 * Wrong-type fixtures — values that don't coerce to the expected type.
 * Tests must assert that parseEnv returns ok=false with the offending variable.
 */

/** PORT set to a non-numeric string that cannot be coerced */
export const wrongPortTypeEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "not-a-number",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://auth_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5",
  JWT_SECRET:
    "dev-jwt-signing-key-that-is-long-enough-for-validation-purposes-only",
};

/** DATABASE_URL with a non-postgresql scheme */
export const wrongDatabaseUrlSchemeEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "info",
  DATABASE_URL: "mysql://auth_svc:dev_pass@localhost:3306/travel_dev",
  JWT_SECRET:
    "dev-jwt-signing-key-that-is-long-enough-for-validation-purposes-only",
};

/** LOG_LEVEL set to a value not in the allowed enum */
export const wrongLogLevelEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "verbose", // not in ["trace","debug","info","warn","error","fatal","silent"]
  DATABASE_URL:
    "postgresql://auth_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5",
  JWT_SECRET:
    "dev-jwt-signing-key-that-is-long-enough-for-validation-purposes-only",
};

/** JWT_SECRET too short (below minLength: 32) */
export const shortJwtSecretEnv: Record<string, string> = {
  NODE_ENV: "development",
  PORT: "3001",
  LOG_LEVEL: "info",
  DATABASE_URL:
    "postgresql://auth_svc:dev_pass@localhost:5432/travel_dev?connection_limit=5",
  JWT_SECRET: "too-short",
};
