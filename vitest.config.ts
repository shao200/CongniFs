import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    external: ['node:sqlite'],
  },
  test: {
    testTimeout: 20_000,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
});
