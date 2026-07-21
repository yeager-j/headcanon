import { defineConfig, devices } from "@playwright/test"

const isCI = !!process.env.CI

export default defineConfig({
  testDir: "./e2e",
  // One worker: the in-memory authority is process-global, and each test
  // resets it. Parallel workers would race the reset.
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:3900",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // In CI the root `npm run build` has already produced .next (same pattern
  // as apps/web); locally the dev server preserves the inner loop.
  webServer: {
    command: isCI ? "npm run start" : "npm run dev",
    url: "http://localhost:3900",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
})
