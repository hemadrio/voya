/**
 * Per-environment CORS origin allow-list.
 *
 * Design rules:
 *   - Never use a wildcard with credentials=true.
 *   - Only allow-listed origins are echoed back in Access-Control-Allow-Origin.
 *   - The list is configuration-driven per environment, not driven by a single
 *     FRONTEND_URL env var, so staging and production cannot accidentally share
 *     a permissive dev value.
 *   - Extend this list by environment when a new frontend hostname is deployed.
 */

export interface CorsOriginConfig {
  readonly allowedOrigins: ReadonlyArray<string>;
}

const ORIGINS_BY_ENV: Record<string, ReadonlyArray<string>> = {
  production: [
    'https://app.voya.travel',
    'https://www.voya.travel',
  ],
  staging: [
    'https://staging.voya.travel',
    'https://app-staging.voya.travel',
  ],
  development: [
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  test: [
    'http://localhost:3000',
    'https://allowed.example.com',
  ],
};

/**
 * Return the CORS configuration for the given NODE_ENV.
 * Falls back to the development allow-list for unknown environments so local
 * development always works without an env file.
 */
export function getCorsConfig(nodeEnv?: string): CorsOriginConfig {
  const env = nodeEnv ?? process.env['NODE_ENV'] ?? 'development';
  const allowedOrigins = ORIGINS_BY_ENV[env] ?? ORIGINS_BY_ENV['development']!;
  return { allowedOrigins };
}
