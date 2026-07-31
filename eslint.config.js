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
  {
    // Architecture rule: domain-service modules must not import Express or
    // @prisma/client directly.  Business logic in src/domain/ must depend only
    // on pure TypeScript interfaces (duck-typed repository / presenter contracts)
    // so the unit-test harness can run without any infrastructure.
    //
    // Violations fail the lint step — not just a warning — so CI blocks the PR.
    files: ['services/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'express',
              message:
                'Domain services must not import Express directly. ' +
                'Accept typed interfaces via constructor injection instead.',
            },
            {
              name: '@prisma/client',
              message:
                'Domain services must not import @prisma/client directly. ' +
                'Accept a duck-typed repository interface via constructor injection instead.',
            },
          ],
        },
      ],
    },
  },
];
