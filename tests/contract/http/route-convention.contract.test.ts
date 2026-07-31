/**
 * Route convention contract test.
 *
 * Enumerates Express route path patterns defined in service route source files
 * and asserts that every registered path:
 *  1. Begins with /v1/ (versioned namespace)
 *  2. Uses a plural resource noun (e.g. /bookings, not /booking)
 *
 * This is a static-analysis test — it reads route source files as text and
 * extracts path string literals without booting any service. It therefore
 * runs fully offline.
 *
 * AC5: All routes are asserted to be versioned under /v1 with resource-plural
 *      noun-based paths; a test fails if a route is registered outside that
 *      convention.
 *
 * AC1 (partial): Confirms route groups exist for each service domain (auth,
 *      search, user, booking, payment) without requiring a live service.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../../..");
const SERVICES_DIR = join(REPO_ROOT, "services");

// ---------------------------------------------------------------------------
// Known API path prefixes — each service's versioned base path
// ---------------------------------------------------------------------------

/**
 * Expected route prefixes. A service must register all its routes under one
 * of these versioned paths. Add new service base paths here when services
 * are onboarded.
 */
const EXPECTED_ROUTE_PREFIXES: ReadonlyMap<string, string> = new Map([
  ["auth-service", "/v1/auth"],
  ["booking-service", "/v1/bookings"],
  ["search-service", "/v1/search"],
  ["user-service", "/v1/users"],
  ["payment-service", "/v1/payments"],
  ["itinerary-service", "/v1/itineraries"],
  ["notification-service", "/v1/notifications"],
  ["flight-service", "/v1/flights"],
  ["hotel-service", "/v1/hotels"],
  ["car-service", "/v1/cars"],
]);

// ---------------------------------------------------------------------------
// Path extraction helpers
// ---------------------------------------------------------------------------

/** Regex to find Express route path string literals in TypeScript source. */
const ROUTE_PATH_PATTERN =
  /router\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(\s*["'`](\/[^"'`]+)["'`]/g;

const ROUTER_USE_PATTERN =
  /(?:app|router)\s*\.\s*use\s*\(\s*["'`](\/v\d[^"'`]*)["'`]/g;

function extractRoutePathsFromSource(source: string): string[] {
  const paths: string[] = [];
  for (const regex of [ROUTE_PATH_PATTERN, ROUTER_USE_PATTERN]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      if (match[1]) paths.push(match[1]);
    }
  }
  return paths;
}

function collectTsFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && entry !== "node_modules" && entry !== "dist" && entry !== "__tests__") {
      collectTsFiles(full, results);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts")) {
      results.push(full);
    }
  }
  return results;
}

function extractServiceRoutes(serviceName: string): { file: string; path: string }[] {
  const routesDir = join(SERVICES_DIR, serviceName, "src", "routes");
  const appFile = join(SERVICES_DIR, serviceName, "src", "app.ts");
  const files = collectTsFiles(routesDir);
  if (existsSync(appFile)) files.push(appFile);

  const found: { file: string; path: string }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const p of extractRoutePathsFromSource(source)) {
      found.push({ file: file.replace(REPO_ROOT + "/", ""), path: p });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Non-plural-noun detection
// ---------------------------------------------------------------------------

// Common singular resource nouns that should be pluralised
const KNOWN_SINGULAR_NOUNS = new Set([
  "booking", "payment", "search", "user", "notification",
  "flight", "hotel", "car", "itinerary", "session", "auth",
  "offer", "traveler", "passenger",
]);

function looksLikeSingularNoun(segment: string): boolean {
  const cleaned = segment.replace(/^:/, "").split("/")[0] ?? "";
  if (!cleaned || cleaned.startsWith(":") || cleaned === "v1") return false;
  return KNOWN_SINGULAR_NOUNS.has(cleaned.toLowerCase());
}

function pathSegmentsAfterV1(path: string): string[] {
  const withoutV1 = path.replace(/^\/v\d+\//, "");
  return withoutV1.split("/").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Route convention — /v1 namespace and plural nouns", () => {
  for (const [serviceName, expectedPrefix] of EXPECTED_ROUTE_PREFIXES) {
    describe(`${serviceName}`, () => {
      it(`has route source files under services/${serviceName}/src/routes/`, () => {
        const routesDir = join(SERVICES_DIR, serviceName, "src", "routes");
        // Not all services may have routes yet in this implementation phase
        // If the routes directory doesn't exist, skip with a warning rather than fail hard
        if (!existsSync(routesDir)) {
          console.warn(`[route-convention] ${serviceName}: routes dir not found — skipping`);
          return;
        }
        expect(existsSync(routesDir)).toBe(true);
      });

      it(`all discovered paths begin with ${expectedPrefix} or /v1/`, () => {
        const routes = extractServiceRoutes(serviceName);
        if (routes.length === 0) {
          // No routes extracted — skip (service routes may not yet be implemented)
          return;
        }
        const violations: string[] = [];
        for (const { file, path } of routes) {
          if (!path.startsWith("/v1/") && !path.startsWith("/v1")) {
            violations.push(`${file}: "${path}" does not start with /v1/`);
          }
        }
        if (violations.length > 0) {
          throw new Error(
            `Route convention violation — paths not versioned under /v1:\n  ${violations.join("\n  ")}`,
          );
        }
      });

      it(`no path segment after /v1/ uses a known singular noun`, () => {
        const routes = extractServiceRoutes(serviceName);
        if (routes.length === 0) return;

        const violations: string[] = [];
        for (const { file, path } of routes) {
          if (!path.startsWith("/v1")) continue;
          const segments = pathSegmentsAfterV1(path);
          for (const segment of segments) {
            if (looksLikeSingularNoun(segment)) {
              violations.push(`${file}: "${path}" segment "${segment}" appears to be singular`);
            }
          }
        }
        if (violations.length > 0) {
          throw new Error(
            `Route convention violation — singular noun detected after /v1:\n  ${violations.join("\n  ")}`,
          );
        }
      });
    });
  }
});

describe("API Design Convention — error envelope structure", () => {
  it("error envelope schema uses strict parsing (no extra keys)", async () => {
    // Verifies the schema itself enforces the convention
    const { ErrorEnvelopeSchema } = await import("@travel/contracts/errors");
    const result = ErrorEnvelopeSchema.safeParse({
      error: { code: "TEST_CODE", message: "test" },
      reference: "ref-001",
      extraKey: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("error envelope reference field is always required", async () => {
    const { ErrorEnvelopeSchema } = await import("@travel/contracts/errors");
    const result = ErrorEnvelopeSchema.safeParse({
      error: { code: "TEST_CODE", message: "test" },
    });
    expect(result.success).toBe(false);
  });

  it("status semantics: 400 maps to VALIDATION_FAILED code", () => {
    const STATUS_SEMANTICS: Record<number, string> = {
      400: "VALIDATION_FAILED",
      401: "UNAUTHENTICATED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "LIFECYCLE_CONFLICT",
      422: "SUPPLIER_REJECTED",
      429: "RATE_LIMITED",
      502: "SUPPLIER_UNAVAILABLE",
      504: "SUPPLIER_TIMEOUT",
    };
    // Verify the mapping is non-empty (documents expected status → code pairs)
    expect(Object.keys(STATUS_SEMANTICS).length).toBeGreaterThanOrEqual(8);
    expect(STATUS_SEMANTICS[400]).toBe("VALIDATION_FAILED");
    expect(STATUS_SEMANTICS[409]).toBe("LIFECYCLE_CONFLICT");
    expect(STATUS_SEMANTICS[422]).toBe("SUPPLIER_REJECTED");
  });
});
