/**
 * ESLint config for @travel/observability.
 *
 * Bans console.* outright — this package IS the logger, so every call
 * site must go through the Pino logger instance, never through console.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    'no-console': 'error',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'express',
            message:
              '@travel/observability must stay dependency-light: Express is a devDep for tests only.',
          },
          {
            name: '@prisma/client',
            message: '@travel/observability must not import Prisma.',
          },
          {
            name: 'aws-sdk',
            message: '@travel/observability must not import AWS SDKs.',
          },
        ],
        patterns: [
          {
            group: ['@aws-sdk/*'],
            message: '@travel/observability must not import AWS SDKs.',
          },
        ],
      },
    ],
  },
};
