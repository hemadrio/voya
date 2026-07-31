/**
 * Shared Vitest configuration and coverage preset.
 *
 * Every service and package extends this to ensure consistent coverage
 * reporting format (lcov + json-summary) required by the pipeline gate.
 *
 * Usage — minimum (inherits all defaults):
 *   import { createBaseConfig } from "@travel/test-config";
 *   export default createBaseConfig();
 *
 * Usage — with per-service overrides (test options only):
 *   export default createBaseConfig({ setupFiles: ["./test/setup.ts"] });
 *
 * Usage — with top-level Vite options (e.g. resolve.alias):
 *   export default createBaseConfig({}, { resolve: { alias: { "@/": "./src/" } } });
 */

import { defineConfig, mergeConfig } from "vitest/config";
import type { InlineConfig } from "vitest";

/** Reporters shared across every package so the pipeline always finds the same files. */
export const COVERAGE_REPORTERS = ["text", "lcov", "json-summary"] as const;

/**
 * Build a Vitest config from the platform baseline.
 *
 * @param testOverrides  - Partial InlineConfig merged into the default `test` block.
 * @param vitestOverrides - Full Vite/Vitest UserConfig for top-level options like `resolve`.
 */
export function createBaseConfig(
  testOverrides?: Partial<InlineConfig>,
  vitestOverrides?: object,
) {
  const base = defineConfig({
    test: {
      environment: "node",
      include: ["test/**/*.test.ts", "__tests__/**/*.test.ts"],
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov", "json-summary"],
        include: ["src/**/*.ts"],
        reportsDirectory: "./coverage",
        clean: true,
      },
      ...testOverrides,
    },
  });

  if (!vitestOverrides) return base;
  return mergeConfig(base, vitestOverrides);
}
