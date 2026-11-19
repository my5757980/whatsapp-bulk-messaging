import { defineConfig, devices } from '@playwright/test';

// E2E runs against the full local stack with tools/mock-meta instead of Meta (constitution V).
// Ops-protected health endpoints answer 401 without the token, which Playwright counts as "up".
const repoRoot = '../..';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  // In CI the github reporter turns failures into annotations on the run (readable without the logs).
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev -w @wbm/mock-meta',
      url: 'http://localhost:4010/health',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w @wbm/api',
      url: 'http://localhost:4000/api/health',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'npm run dev:worker -w @wbm/api',
      url: 'http://localhost:4001/health',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'npm run dev -w @wbm/web',
      url: 'http://localhost:3000/login',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
