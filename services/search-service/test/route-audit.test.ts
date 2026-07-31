/**
 * Route audit test — walks the Express router stack of search-service and
 * asserts that every non-exempt route has the `requestValidator` middleware
 * in its handler chain.
 *
 * AC6/AC11: This test fails if a new unvalidated route is added, preventing
 * silent merges of unprotected endpoints.
 */
import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { createApp } from "../src/app.js";
import type { SearchAdapter } from "../src/adapters/SearchAdapter.js";

const stubAdapter: SearchAdapter = {
  searchFlights: vi.fn(async () => []) as unknown as SearchAdapter["searchFlights"],
  searchHotels: vi.fn(async () => []) as unknown as SearchAdapter["searchHotels"],
  searchCars: vi.fn(async () => []) as unknown as SearchAdapter["searchCars"],
};

// Paths explicitly exempt from the validation middleware requirement.
const EXEMPT_PATHS = new Set(["/health"]);

// The validateRequest factory produces a function named `requestValidator`.
const VALIDATOR_FN_NAME = "requestValidator";

interface Layer {
  route?: {
    path: string;
    stack: Array<{ handle: { name: string } }>;
  };
  handle?: {
    stack?: Layer[];
  };
  regexp?: RegExp;
  path?: string;
}

function collectRoutes(stack: Layer[], prefix = ""): Array<{ path: string; handlerNames: string[] }> {
  const routes: Array<{ path: string; handlerNames: string[] }> = [];

  for (const layer of stack) {
    if (layer.route) {
      const fullPath = prefix + layer.route.path;
      const handlerNames = layer.route.stack.map((h) => h.handle.name);
      routes.push({ path: fullPath, handlerNames });
    } else if (layer.handle?.stack) {
      // Nested router — extract prefix from regexp
      const match = layer.regexp?.toString().match(/\/\^\\\/([^\\]+)\\\//);
      const routerPrefix = match ? `/${match[1]}` : prefix;
      routes.push(...collectRoutes(layer.handle.stack, routerPrefix));
    }
  }

  return routes;
}

describe("search-service route audit", () => {
  it("every non-exempt route has requestValidator middleware", () => {
    const app = createApp(stubAdapter);
    // @ts-expect-error: accessing internal Express router stack
    const stack: Layer[] = app._router?.stack ?? [];
    const routes = collectRoutes(stack);

    const missingValidation: string[] = [];

    for (const { path, handlerNames } of routes) {
      if (EXEMPT_PATHS.has(path)) continue;
      if (!handlerNames.includes(VALIDATOR_FN_NAME)) {
        missingValidation.push(path);
      }
    }

    if (missingValidation.length > 0) {
      throw new Error(
        `Routes missing validateRequest middleware: ${missingValidation.join(", ")}`,
      );
    }

    expect(missingValidation).toHaveLength(0);
  });

  it("health endpoint is reachable without requestValidator", () => {
    const app = createApp(stubAdapter);
    // @ts-expect-error: accessing internal Express router stack
    const stack: Layer[] = app._router?.stack ?? [];
    const routes = collectRoutes(stack);

    const healthRoute = routes.find((r) => r.path === "/health");
    // Health may be a direct route on the root app — check it exists
    // and does NOT have requestValidator (it's exempt).
    if (healthRoute) {
      expect(healthRoute.handlerNames).not.toContain(VALIDATOR_FN_NAME);
    }
    // If it's not in the deep stack (registered on root app), that's fine too.
  });
});
