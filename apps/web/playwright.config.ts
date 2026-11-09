import { defineConfig, devices } from '@playwright/test';

// End-to-end tests: a real browser against the real app (API + worker + web), using the offline
// fake AI provider, so they need no API key and give deterministic answers.
// Requires Postgres (npm run db:up locally; a service container in CI).
const API_PORT = 4100;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: 'node ../api/src/all-in-one.ts --demo',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://documind:documind@localhost:5432/documind_e2e',
        WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
