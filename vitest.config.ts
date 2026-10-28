import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    globals: true,
    // Builds the plugin and the server once, so tests only read the output.
    globalSetup: ['./test/globalSetup.ts'],
  },
});
