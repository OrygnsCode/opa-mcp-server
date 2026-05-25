import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./tests/setup.ts'],

  },
});
