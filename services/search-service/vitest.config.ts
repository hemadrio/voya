import { createBaseConfig } from "@travel/test-config";
import { resolve } from "path";

const root = resolve(__dirname, "../..");

export default createBaseConfig(
  {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      reportsDirectory: "./coverage",
      clean: true,
    },
  },
  {
    resolve: {
      alias: {
        "@travel/contracts": resolve(root, "packages/contracts/src/index.ts"),
        "@travel/observability": resolve(root, "packages/observability/src/index.ts"),
        "@travel/search-cache": resolve(root, "packages/search-cache/src/index.ts"),
      },
    },
  },
);
