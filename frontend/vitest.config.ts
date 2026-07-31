import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "./components"),
      "@/lib": path.resolve(__dirname, "./lib"),
      "@/types": path.resolve(__dirname, "./types"),
      "@/app": path.resolve(__dirname, "./app"),
      "@/test": path.resolve(__dirname, "./test"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: [
      "lib/__tests__/**/*.test.ts",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
      "test/unit/**/*.test.ts",
      "test/unit/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts", "components/**/*.tsx"],
    },
    env: {
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:4000/api/v1",
      NODE_ENV: "test",
    },
  },
});
