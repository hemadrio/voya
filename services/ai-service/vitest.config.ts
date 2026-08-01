import { createBaseConfig } from "@travel/test-config";

export default createBaseConfig({
  include: ["test/**/*.test.ts", "__tests__/**/*.test.ts", "eval/test/**/*.test.ts"],
  coverage: {
    provider: "v8",
    reporter: ["text", "lcov", "json-summary"],
    include: ["src/**/*.ts", "eval/**/*.ts"],
    exclude: ["eval/test/**", "eval/gate.ts"],
    reportsDirectory: "./coverage",
    clean: true,
  },
});
