import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["middleware/test/**/*.test.ts", "config/test/**/*.test.ts"],
    environment: "node",
  },
});
