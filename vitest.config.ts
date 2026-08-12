import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      // Keep the structured logger quiet unless a test is debugging it.
      LOG_LEVEL: 'error',
    },
  },
});
