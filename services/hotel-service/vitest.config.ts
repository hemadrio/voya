import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@travel/contracts': resolve(root, 'packages/contracts/src/index.ts'),
      '@travel/supplier-port': resolve(root, 'packages/supplier-port/src/index.ts'),
      '@travel/suppliers': resolve(root, 'packages/suppliers/src/index.ts'),
      '@travel/observability': resolve(root, 'packages/observability/src/index.ts'),
    },
  },
});
