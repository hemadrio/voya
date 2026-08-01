import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["**/*.scenario.ts", "**/*.resilience.test.ts"],
    testTimeout: 15_000,
    reporters: ["verbose"],
  },
});
