import { createBaseConfig } from "@travel/test-config";

export default createBaseConfig({
  coverage: {
    provider: "v8",
    reporter: ["text", "lcov", "json-summary"],
    include: ["src/**/*.ts"],
    reportsDirectory: "./coverage",
    clean: true,
  },
});
