/**
 * Lint boundary for @travel/contracts.
 *
 * The `any` type is banned outright (enforces the strict-typing acceptance
 * criterion) and a couple of import-restriction rules back up the automated
 * dependency-boundary test by failing lint the moment someone types an
 * `import ... from 'express'` (etc.) even before it lands in package.json.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ["dist", "node_modules"],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-assignment": "off",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          { name: "express", message: "@travel/contracts must stay dependency-light: no Express in this package." },
          { name: "@prisma/client", message: "@travel/contracts must not import Prisma; mirror enum values only." },
          { name: "stripe", message: "@travel/contracts must not import vendor SDKs." },
          { name: "@anthropic-ai/sdk", message: "@travel/contracts must not import vendor SDKs." },
          { name: "aws-sdk", message: "@travel/contracts must not import AWS SDKs." },
        ],
        patterns: [
          { group: ["@aws-sdk/*"], message: "@travel/contracts must not import AWS SDKs." },
        ],
      },
    ],
  },
};
