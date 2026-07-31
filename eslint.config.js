/**
 * Root ESLint flat config (ESLint 8.57+ with ESLINT_USE_FLAT_CONFIG=true,
 * or ESLint 9+ by default).
 *
 * Applies the no-console rule to all service and package source directories
 * so that console.* regressions are caught at lint time, not code review.
 *
 * Individual packages may extend this with their own eslint config; the
 * no-console rule is deliberately set at the root so it cannot be
 * accidentally omitted from a new service scaffold.
 *
 * Usage:
 *   pnpm exec eslint "services/*\/src/**\/*.ts" "packages/*\/src/**\/*.ts"
 *   # or via turbo: pnpm turbo lint
 */

export default [
  {
    // Applies to all service and package source directories.
    files: ['services/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // Explicitly allow console.* in test files and scripts — these run in
    // development or CI, not in production service processes.
    files: [
      'services/*/test/**/*.ts',
      'packages/*/__tests__/**/*.ts',
      'packages/*/test/**/*.ts',
      'packages/*/scripts/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
];
