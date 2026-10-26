import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'OBSERVER_MOCK_MODE=true OBSERVER_LISTEN_ADDR=127.0.0.1:18080 OBSERVER_CORS_ALLOWED_ORIGINS=http://127.0.0.1:15173,http://localhost:15173 go run ./cmd/observer',
      cwd: '../backend/observer',
      url: 'http://127.0.0.1:18080/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: 'VITE_API_PROXY_TARGET=http://127.0.0.1:18080 pnpm vite --host 127.0.0.1 --port 15173',
      url: 'http://127.0.0.1:15173',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
