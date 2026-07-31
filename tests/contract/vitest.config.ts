import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["**/*.contract.test.ts", "**/*.contract.spec.ts"],
    testTimeout: 15_000,
  },
});
