import { describe, expect, it } from "vitest";
import {
  buildDatabaseUrl,
  buildLocalDatabaseUrl,
  assertConnectionLimit,
  MAX_SERVICE_CONNECTION_LIMIT,
  MIGRATION_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
} from "../src/databaseUrl.js";

// ---------------------------------------------------------------------------
// buildDatabaseUrl
// ---------------------------------------------------------------------------

describe("buildDatabaseUrl", () => {
  const BASE = {
    host: "travel-proxy.proxy-xyz.eu-west-1.rds.amazonaws.com",
    port: 5432,
    database: "travel",
    user: "booking_svc",
    password: "iam-auth-token-abc123",
    connectionLimit: MAX_SERVICE_CONNECTION_LIMIT,
    poolTimeoutSeconds: DEFAULT_POOL_TIMEOUT_SECONDS,
    sslmode: "require" as const,
  };

  it("produces a postgresql:// URL", () => {
    const url = buildDatabaseUrl(BASE);
    expect(url.startsWith("postgresql://")).toBe(true);
  });

  it("includes the host, port and database in the URL", () => {
    const url = buildDatabaseUrl(BASE);
    expect(url).toContain("travel-proxy.proxy-xyz.eu-west-1.rds.amazonaws.com:5432/travel");
  });

  it("includes sslmode=require by default", () => {
    const url = buildDatabaseUrl(BASE);
    const params = new URL(url).searchParams;
    expect(params.get("sslmode")).toBe("require");
  });

  it("injects connection_limit into the query string", () => {
    const url = buildDatabaseUrl(BASE);
    const params = new URL(url).searchParams;
    expect(params.get("connection_limit")).toBe(String(MAX_SERVICE_CONNECTION_LIMIT));
  });

  it("injects pool_timeout into the query string", () => {
    const url = buildDatabaseUrl(BASE);
    const params = new URL(url).searchParams;
    expect(params.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
  });

  it("URL-encodes special characters in the password (IAM token format)", () => {
    const tokenWithSpecialChars = "AQIDBAUGBwgJ/KLM+NOP=QRS";
    const url = buildDatabaseUrl({ ...BASE, password: tokenWithSpecialChars });
    // The raw token must not appear unencoded; the encoded form must appear
    const encodedToken = encodeURIComponent(tokenWithSpecialChars);
    expect(url).toContain(encodedToken);
    expect(url).not.toContain(tokenWithSpecialChars);
  });

  it("accepts connection_limit equal to MAX_SERVICE_CONNECTION_LIMIT", () => {
    expect(() =>
      buildDatabaseUrl({ ...BASE, connectionLimit: MAX_SERVICE_CONNECTION_LIMIT }),
    ).not.toThrow();
  });

  it("accepts MIGRATION_CONNECTION_LIMIT for migration tasks", () => {
    const url = buildDatabaseUrl({ ...BASE, connectionLimit: MIGRATION_CONNECTION_LIMIT });
    const params = new URL(url).searchParams;
    expect(params.get("connection_limit")).toBe(String(MIGRATION_CONNECTION_LIMIT));
  });

  it("applies extraParams to the query string", () => {
    const url = buildDatabaseUrl({
      ...BASE,
      extraParams: { schema: "public", statement_timeout: "30000" },
    });
    const params = new URL(url).searchParams;
    expect(params.get("schema")).toBe("public");
    expect(params.get("statement_timeout")).toBe("30000");
  });

  it("defaults port to 5432 when not specified", () => {
    const { port: _port, ...rest } = BASE;
    const url = buildDatabaseUrl(rest as typeof BASE);
    expect(url).toContain(":5432/");
  });

  it("defaults sslmode to 'require' when not specified", () => {
    const { sslmode: _ssl, ...rest } = BASE;
    const url = buildDatabaseUrl(rest as typeof BASE);
    expect(new URL(url).searchParams.get("sslmode")).toBe("require");
  });
});

// ---------------------------------------------------------------------------
// assertConnectionLimit
// ---------------------------------------------------------------------------

describe("assertConnectionLimit", () => {
  const makeUrl = (limit: number | null, sslmode = "require") => {
    const base = `postgresql://svc:pwd@proxy.example.com:5432/travel?sslmode=${sslmode}`;
    if (limit === null) return base;
    return `${base}&connection_limit=${limit}`;
  };

  it("does not throw when connection_limit equals the ceiling", () => {
    expect(() =>
      assertConnectionLimit(makeUrl(MAX_SERVICE_CONNECTION_LIMIT)),
    ).not.toThrow();
  });

  it("does not throw when connection_limit is below the ceiling", () => {
    expect(() => assertConnectionLimit(makeUrl(1))).not.toThrow();
    expect(() => assertConnectionLimit(makeUrl(3))).not.toThrow();
  });

  it("throws when connection_limit is above the policy ceiling", () => {
    expect(() =>
      assertConnectionLimit(makeUrl(MAX_SERVICE_CONNECTION_LIMIT + 1)),
    ).toThrow(/exceeds the policy ceiling/);
  });

  it("throws when connection_limit is missing from the URL", () => {
    expect(() => assertConnectionLimit(makeUrl(null))).toThrow(/missing the required connection_limit/);
  });

  it("throws when connection_limit is an empty string", () => {
    const url = `postgresql://svc:pwd@proxy.example.com:5432/travel?connection_limit=`;
    expect(() => assertConnectionLimit(url)).toThrow(/missing the required connection_limit/);
  });

  it("throws when connection_limit is not a valid integer", () => {
    const url = `postgresql://svc:pwd@proxy.example.com:5432/travel?connection_limit=abc`;
    expect(() => assertConnectionLimit(url)).toThrow(/not a valid positive integer/);
  });

  it("throws when DATABASE_URL is not a valid URL", () => {
    expect(() => assertConnectionLimit("not-a-url")).toThrow(/not a valid URL/);
  });

  it("accepts a custom ceiling for the migration task", () => {
    expect(() =>
      assertConnectionLimit(makeUrl(MIGRATION_CONNECTION_LIMIT), MIGRATION_CONNECTION_LIMIT),
    ).not.toThrow();
  });

  it("rejects MIGRATION_CONNECTION_LIMIT with the service ceiling", () => {
    expect(() =>
      assertConnectionLimit(makeUrl(MIGRATION_CONNECTION_LIMIT), MAX_SERVICE_CONNECTION_LIMIT),
    ).toThrow(/exceeds the policy ceiling/);
  });

  it("error message mentions connection_limit=5 as the expected value", () => {
    try {
      assertConnectionLimit(makeUrl(null));
    } catch (err) {
      expect((err as Error).message).toContain(`connection_limit=${MAX_SERVICE_CONNECTION_LIMIT}`);
    }
  });

  it("error message does not include the database password (security)", () => {
    try {
      assertConnectionLimit(makeUrl(100));
    } catch (err) {
      expect((err as Error).message).not.toContain("pwd");
    }
  });
});

// ---------------------------------------------------------------------------
// buildLocalDatabaseUrl
// ---------------------------------------------------------------------------

describe("buildLocalDatabaseUrl", () => {
  it("produces sslmode=disable for local dev", () => {
    const url = buildLocalDatabaseUrl({
      database: "travel_dev",
      user: "postgres",
      password: "postgres",
    });
    expect(new URL(url).searchParams.get("sslmode")).toBe("disable");
  });

  it("defaults to localhost:5432", () => {
    const url = buildLocalDatabaseUrl({
      database: "travel_dev",
      user: "postgres",
      password: "postgres",
    });
    expect(url).toContain("localhost:5432");
  });

  it("enforces the same connection_limit default as production", () => {
    const url = buildLocalDatabaseUrl({
      database: "travel_dev",
      user: "postgres",
      password: "postgres",
    });
    expect(new URL(url).searchParams.get("connection_limit")).toBe(
      String(MAX_SERVICE_CONNECTION_LIMIT),
    );
  });

  it("includes pool_timeout", () => {
    const url = buildLocalDatabaseUrl({
      database: "travel_dev",
      user: "postgres",
      password: "postgres",
    });
    expect(new URL(url).searchParams.get("pool_timeout")).toBe(
      String(DEFAULT_POOL_TIMEOUT_SECONDS),
    );
  });
});

// ---------------------------------------------------------------------------
// Policy constant sanity checks
// ---------------------------------------------------------------------------

describe("policy constants", () => {
  it("MAX_SERVICE_CONNECTION_LIMIT is 5", () => {
    expect(MAX_SERVICE_CONNECTION_LIMIT).toBe(5);
  });

  it("MIGRATION_CONNECTION_LIMIT is 10", () => {
    expect(MIGRATION_CONNECTION_LIMIT).toBe(10);
  });

  it("DEFAULT_POOL_TIMEOUT_SECONDS is 10", () => {
    expect(DEFAULT_POOL_TIMEOUT_SECONDS).toBe(10);
  });
});
