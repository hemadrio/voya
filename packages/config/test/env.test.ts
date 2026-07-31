/**
 * Unit tests for the shared environment schema and startup validator.
 *
 * Tests cover:
 *   1. parseEnv — valid, missing-required, wrong-type, URL scheme
 *   2. validateStartupEnv — placeholder in development (warn), placeholder in
 *      production (exit), schema error always exits, no values in log output
 */

import { describe, expect, it } from "vitest";
import {
  authServiceEnvSchema,
  paymentServiceEnvSchema,
  apiGatewayEnvSchema,
  parseEnv,
} from "../src/env.js";
import { validateStartupEnv } from "../src/validate-startup.js";
import { validAuthEnv, validPaymentEnv, validApiGatewayEnv } from "./fixtures/valid-env.js";
import {
  missingDatabaseUrlEnv,
  missingStripeKeysEnv,
  missingRedisUrlEnv,
} from "./fixtures/missing-required-env.js";
import {
  wrongPortTypeEnv,
  wrongDatabaseUrlSchemeEnv,
  wrongLogLevelEnv,
  shortJwtSecretEnv,
} from "./fixtures/wrong-type-env.js";
import {
  placeholderJwtSecretEnv,
  placeholderStripeKeyEnv,
  placeholderStripeKeyDevEnv,
} from "./fixtures/placeholder-env.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger() {
  return {
    warnMessages: [] as Array<{ obj: Record<string, unknown>; msg: string }>,
    fatalMessages: [] as Array<{ obj: Record<string, unknown>; msg: string }>,
    warn(obj: Record<string, unknown>, msg: string) {
      this.warnMessages.push({ obj, msg });
    },
    error(obj: Record<string, unknown>, msg: string) {
      this.fatalMessages.push({ obj, msg });
    },
    fatal(obj: Record<string, unknown>, msg: string) {
      this.fatalMessages.push({ obj, msg });
    },
  };
}

// ---------------------------------------------------------------------------
// parseEnv — pure function, no side effects
// ---------------------------------------------------------------------------

describe("parseEnv", () => {
  describe("valid environments", () => {
    it("accepts a valid auth-service environment", () => {
      const result = parseEnv(authServiceEnvSchema, validAuthEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.PORT).toBe(3001);
        expect(result.config.NODE_ENV).toBe("development");
        expect(result.config.LOG_LEVEL).toBe("info");
      }
    });

    it("accepts a valid payment-service environment", () => {
      const result = parseEnv(paymentServiceEnvSchema, validPaymentEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.PORT).toBe(3007);
        expect(result.config.STRIPE_SECRET_KEY).toBeDefined();
      }
    });

    it("accepts a valid api-gateway environment", () => {
      const result = parseEnv(apiGatewayEnvSchema, validApiGatewayEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.PORT).toBe(3000);
        expect(result.config.REDIS_URL).toBe("redis://localhost:6379");
      }
    });

    it("coerces PORT from string to number", () => {
      const result = parseEnv(authServiceEnvSchema, { ...validAuthEnv, PORT: "4001" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.PORT).toBe(4001);
      }
    });

    it("applies LOG_LEVEL default when omitted", () => {
      const { LOG_LEVEL: _, ...withoutLogLevel } = validAuthEnv;
      const result = parseEnv(authServiceEnvSchema, withoutLogLevel);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.LOG_LEVEL).toBe("info");
      }
    });

    it("returns a frozen config object", () => {
      const result = parseEnv(authServiceEnvSchema, validAuthEnv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.isFrozen(result.config)).toBe(true);
      }
    });
  });

  describe("missing required variables", () => {
    it("rejects auth-service env with DATABASE_URL absent", () => {
      const result = parseEnv(authServiceEnvSchema, missingDatabaseUrlEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("DATABASE_URL");
      }
    });

    it("rejects payment-service env with Stripe keys absent", () => {
      const result = parseEnv(paymentServiceEnvSchema, missingStripeKeysEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("STRIPE_SECRET_KEY");
        expect(paths).toContain("STRIPE_WEBHOOK_SECRET");
      }
    });

    it("rejects api-gateway env with REDIS_URL absent", () => {
      const result = parseEnv(apiGatewayEnvSchema, missingRedisUrlEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("REDIS_URL");
      }
    });

    it("reports all missing variables in one pass", () => {
      const result = parseEnv(paymentServiceEnvSchema, missingStripeKeysEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Both Stripe keys should be reported in the same result
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("wrong types", () => {
    it("rejects PORT=not-a-number", () => {
      const result = parseEnv(authServiceEnvSchema, wrongPortTypeEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("PORT");
      }
    });

    it("rejects DATABASE_URL with non-postgresql scheme", () => {
      const result = parseEnv(authServiceEnvSchema, wrongDatabaseUrlSchemeEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("DATABASE_URL");
      }
    });

    it("rejects LOG_LEVEL not in allowed enum", () => {
      const result = parseEnv(authServiceEnvSchema, wrongLogLevelEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("LOG_LEVEL");
      }
    });

    it("rejects JWT_SECRET shorter than minLength", () => {
      const result = parseEnv(authServiceEnvSchema, shortJwtSecretEnv);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const paths = result.errors.map((e) => e.path);
        expect(paths).toContain("JWT_SECRET");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// validateStartupEnv — process control and placeholder detection
// ---------------------------------------------------------------------------

describe("validateStartupEnv", () => {
  describe("placeholder in development (warn and continue)", () => {
    it("warns about placeholder JWT_SECRET and returns config", () => {
      const logger = makeSilentLogger();
      let exited = false;
      const exitFn = (_code: number) => { exited = true; };

      const config = validateStartupEnv(
        authServiceEnvSchema,
        placeholderJwtSecretEnv,
        { logger, nodeEnv: "development", exit: exitFn },
      );

      expect(exited).toBe(false);
      expect(logger.warnMessages.length).toBeGreaterThan(0);
      expect(config).toBeDefined();
    });

    it("includes variable NAME in warning but never its VALUE", () => {
      const logger = makeSilentLogger();
      const exitFn = (_code: number) => {};

      validateStartupEnv(
        authServiceEnvSchema,
        placeholderJwtSecretEnv,
        { logger, nodeEnv: "development", exit: exitFn },
      );

      const allMessages = logger.warnMessages
        .map((m) => JSON.stringify(m))
        .join(" ");

      // Variable name must appear
      expect(allMessages).toContain("JWT_SECRET");
      // Actual value must NOT appear (the real placeholder value)
      expect(allMessages).not.toContain("dev-secret-change-me");
    });

    it("emits one warn per placeholder variable", () => {
      const logger = makeSilentLogger();
      const exitFn = (_code: number) => {};

      validateStartupEnv(
        authServiceEnvSchema,
        placeholderJwtSecretEnv,
        { logger, nodeEnv: "development", exit: exitFn },
      );

      const perVarWarnings = logger.warnMessages.filter((m) =>
        m.obj["variable"] === "JWT_SECRET",
      );
      expect(perVarWarnings.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("placeholder in non-development (hard fail)", () => {
    it("calls exit(1) when placeholder detected in production", () => {
      const logger = makeSilentLogger();
      let exitCode: number | undefined;
      const exitFn = (code: number): never => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      };

      expect(() =>
        validateStartupEnv(
          paymentServiceEnvSchema,
          placeholderStripeKeyEnv,
          { logger, nodeEnv: "production", exit: exitFn },
        ),
      ).toThrow("process.exit(1)");

      expect(exitCode).toBe(1);
    });

    it("logs variable NAME but not VALUE on fatal placeholder", () => {
      const logger = makeSilentLogger();
      const exitFn = (_code: number): never => {
        throw new Error("exiting");
      };

      try {
        validateStartupEnv(
          paymentServiceEnvSchema,
          placeholderStripeKeyEnv,
          { logger, nodeEnv: "production", exit: exitFn },
        );
      } catch {
        /* expected */
      }

      const allMessages = logger.fatalMessages
        .map((m) => JSON.stringify(m))
        .join(" ");

      expect(allMessages).toContain("STRIPE_SECRET_KEY");
      expect(allMessages).not.toContain("change-me");
    });
  });

  describe("schema errors — always fatal", () => {
    it("calls exit(1) when a required variable is missing", () => {
      const logger = makeSilentLogger();
      let exitCode: number | undefined;
      const exitFn = (code: number): never => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      };

      expect(() =>
        validateStartupEnv(
          authServiceEnvSchema,
          missingDatabaseUrlEnv,
          { logger, nodeEnv: "development", exit: exitFn },
        ),
      ).toThrow("process.exit(1)");

      expect(exitCode).toBe(1);
    });

    it("calls exit(1) on wrong-type PORT even in development", () => {
      const logger = makeSilentLogger();
      const exitFn = (_code: number): never => {
        throw new Error("exiting");
      };

      expect(() =>
        validateStartupEnv(
          authServiceEnvSchema,
          wrongPortTypeEnv,
          { logger, nodeEnv: "development", exit: exitFn },
        ),
      ).toThrow("exiting");
    });

    it("logs variable path but never the raw value on schema failure", () => {
      const logger = makeSilentLogger();
      const exitFn = (_code: number): never => {
        throw new Error("exiting");
      };

      try {
        validateStartupEnv(
          authServiceEnvSchema,
          wrongPortTypeEnv,
          { logger, nodeEnv: "development", exit: exitFn },
        );
      } catch {
        /* expected */
      }

      const allMessages = logger.fatalMessages
        .map((m) => JSON.stringify(m))
        .join(" ");

      expect(allMessages).toContain("PORT");
      // Actual invalid value must NOT appear in logs
      expect(allMessages).not.toContain("not-a-number");
    });
  });

  describe("valid environment", () => {
    it("returns typed config without calling exit or logging", () => {
      const logger = makeSilentLogger();
      let exited = false;
      const exitFn = (_code: number) => { exited = true; };

      const config = validateStartupEnv(
        authServiceEnvSchema,
        validAuthEnv,
        { logger, nodeEnv: "development", exit: exitFn },
      );

      expect(exited).toBe(false);
      expect(logger.warnMessages).toHaveLength(0);
      expect(logger.fatalMessages).toHaveLength(0);
      expect(config.PORT).toBe(3001);
    });
  });
});
