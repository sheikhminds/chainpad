import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any GitHub Pages project path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    environmentOptions: {
      happyDOM: { url: 'http://localhost/' },
    },
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The Solidity compiler bundle is ~10 MB; one worker keeps memory sane on
    // phones and low-end CI runners.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
