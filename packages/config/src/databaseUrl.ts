/**
 * Shared database URL builder and connection-limit assertion.
 *
 * Centralises RDS Proxy connection-string construction so all services inherit
 * the same pooling parameters (connection_limit, pool_timeout, sslmode) and
 * the startup assertion enforces the per-service ceiling uniformly.
 *
 * Design decisions (WO-076):
 *   - Direct Prisma connections and PgBouncer sidecars were rejected.  All
 *     production traffic must flow through RDS Proxy with IAM auth + TLS.
 *   - The connection_limit ceiling is enforced at startup, not just at build
 *     time, so a misconfigured environment variable is caught before the
 *     service accepts any requests.
 *   - Local development uses a direct Postgres URL but with the same
 *     connection_limit so pool behaviour is comparable between environments.
 *   - IAM token-based passwords are injected by the caller (obtained from the
 *     AWS SDK generate-db-auth-token API); this module does not call AWS APIs
 *     so it remains free of AWS SDK dependencies.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Maximum allowed connection_limit for request-serving services.
 * The migration task may use a higher limit via buildDatabaseUrl({connectionLimit: MIGRATION_CONNECTION_LIMIT}).
 */
export const MAX_SERVICE_CONNECTION_LIMIT = 5;

/**
 * Allowed connection_limit for the one-off migration ECS task.
 * Documented in infra/terraform/modules/rds-proxy/connection-budget.md.
 */
export const MIGRATION_CONNECTION_LIMIT = 10;

/** Prisma pool_timeout in seconds — how long a query waits for a free connection. */
export const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

// ---------------------------------------------------------------------------
// URL builder input schema
// ---------------------------------------------------------------------------

const BuildUrlSchema = z.object({
  /** Proxy or direct Postgres host. For AWS, use the RDS Proxy endpoint. */
  host: z.string().min(1),
  /** Postgres port (default 5432). */
  port: z.number().int().min(1).max(65535).default(5432),
  /** Database name. */
  database: z.string().min(1),
  /**
   * Database username.  In production this is the service's dedicated Postgres
   * role (e.g. booking_svc); in local dev it is typically "postgres".
   */
  user: z.string().min(1),
  /**
   * Password or IAM authentication token.
   *
   * For IAM auth: obtain the token from the AWS RDS generate-db-auth-token API
   * before calling this function, then pass it here.  The token is valid for
   * 15 minutes — Prisma re-acquires connections within that window through
   * normal pool recycling.
   */
  password: z.string().min(1),
  /**
   * Prisma connection_limit — maximum connections this process opens.
   * Defaults to MAX_SERVICE_CONNECTION_LIMIT (5) for request-serving tasks.
   * The migration task passes MIGRATION_CONNECTION_LIMIT (10).
   *
   * assertConnectionLimit() must be called at service startup to reject
   * values above MAX_SERVICE_CONNECTION_LIMIT for request-serving tasks.
   */
  connectionLimit: z.number().int().min(1).default(MAX_SERVICE_CONNECTION_LIMIT),
  /**
   * Prisma pool_timeout in seconds.
   * Set to DEFAULT_POOL_TIMEOUT_SECONDS by default.
   * The observability package emits a custom metric when this is hit.
   */
  poolTimeoutSeconds: z.number().int().min(1).default(DEFAULT_POOL_TIMEOUT_SECONDS),
  /**
   * PostgreSQL sslmode.
   * Production (proxy): "require" — TLS is mandatory, no plaintext allowed.
   * Local dev (direct): "disable" — local Postgres container uses no TLS.
   */
  sslmode: z.enum(["require", "prefer", "disable"]).default("require"),
  /**
   * Extra Prisma query string parameters appended verbatim.
   * Use for parameters not expressly supported above.
   */
  extraParams: z.record(z.string()).optional(),
});

export type BuildUrlOptions = z.infer<typeof BuildUrlSchema>;

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Construct a Prisma-compatible PostgreSQL connection URL.
 *
 * Format:
 *   postgresql://<user>:<password>@<host>:<port>/<database>?sslmode=...&connection_limit=...&pool_timeout=...
 *
 * The caller is responsible for obtaining a valid IAM auth token before
 * calling this function and for refreshing the Prisma client before the
 * 15-minute token window expires.
 */
export function buildDatabaseUrl(opts: BuildUrlOptions): string {
  const parsed = BuildUrlSchema.parse(opts);

  const encodedPassword = encodeURIComponent(parsed.password);
  const base = `postgresql://${parsed.user}:${encodedPassword}@${parsed.host}:${parsed.port}/${parsed.database}`;

  const params = new URLSearchParams({
    sslmode: parsed.sslmode,
    connection_limit: String(parsed.connectionLimit),
    pool_timeout: String(parsed.poolTimeoutSeconds),
    ...(parsed.extraParams ?? {}),
  });

  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Connection-limit assertion
// ---------------------------------------------------------------------------

/**
 * Parse the connection_limit from a Prisma DATABASE_URL and assert it does
 * not exceed `ceiling` (defaults to MAX_SERVICE_CONNECTION_LIMIT).
 *
 * Called at service startup — throws a descriptive error that fails the
 * container healthcheck rather than allowing the service to accept traffic
 * with an over-ceiling connection count.
 *
 * @param url     - The resolved DATABASE_URL (may be redacted in logs).
 * @param ceiling - Maximum allowed limit (default: MAX_SERVICE_CONNECTION_LIMIT).
 * @throws {Error} When connection_limit is absent or exceeds the ceiling.
 */
export function assertConnectionLimit(
  url: string,
  ceiling: number = MAX_SERVICE_CONNECTION_LIMIT,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "assertConnectionLimit: DATABASE_URL is not a valid URL. " +
        "Ensure the URL is correctly formed before starting the service.",
    );
  }

  const limitParam = parsed.searchParams.get("connection_limit");
  if (limitParam === null || limitParam === "") {
    throw new Error(
      `assertConnectionLimit: DATABASE_URL is missing the required connection_limit parameter. ` +
        `Add ?connection_limit=${MAX_SERVICE_CONNECTION_LIMIT} (or use buildDatabaseUrl) ` +
        `to prevent unbounded connection growth under horizontal scale.`,
    );
  }

  const limit = Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `assertConnectionLimit: connection_limit "${limitParam}" is not a valid positive integer.`,
    );
  }

  if (limit > ceiling) {
    throw new Error(
      `assertConnectionLimit: connection_limit ${limit} exceeds the policy ceiling of ${ceiling}. ` +
        `Reduce connection_limit to ${ceiling} or below. ` +
        `Direct RDS connections and PgBouncer sidecars are not permitted — ` +
        `all services must use RDS Proxy with connection_limit=${MAX_SERVICE_CONNECTION_LIMIT}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local-dev helper
// ---------------------------------------------------------------------------

/**
 * Build a DATABASE_URL for local development against a direct Postgres
 * container.  Uses sslmode=disable and the same connection_limit ceiling as
 * production so pool behaviour is comparable between environments.
 *
 * Never call this in a production code path — the sslmode check in
 * assertConnectionLimit does not distinguish production from local, so TLS
 * is the caller's responsibility.
 */
export function buildLocalDatabaseUrl(opts: {
  host?: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  connectionLimit?: number;
}): string {
  return buildDatabaseUrl({
    host: opts.host ?? "localhost",
    port: opts.port ?? 5432,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    connectionLimit: opts.connectionLimit ?? MAX_SERVICE_CONNECTION_LIMIT,
    poolTimeoutSeconds: DEFAULT_POOL_TIMEOUT_SECONDS,
    sslmode: "disable",
  });
}
