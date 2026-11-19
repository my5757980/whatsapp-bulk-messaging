import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS 12 is ESM-only; Vitest + SWC is its documented default for ESM projects (SWC emits the
// decorator metadata Nest's DI needs). Inline projects inherit the plugins below (Vitest 5).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.int-spec.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          setupFiles: ['test/setup/env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'contract',
          include: ['test/contract/**/*.contract-spec.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          setupFiles: ['test/setup/env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
