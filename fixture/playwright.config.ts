import { defineConfig, devices } from "@playwright/test"

const isCI = !!process.env.CI
const baseURL = "http://localhost:3900"

export default defineConfig({
  testDir: "./e2e",
  // One worker: the in-memory authority is process-global, and each test
  // resets it. Parallel workers would race the reset.
  workers: 1,
  forbidOnly: isCI,
  // No retries: this suite is the control for an intermittent held-open-Action
  // deadlock, and a retry would let a hang that fails one run in three pass.
  retries: 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    // Without retries, the first failure is the only one, so keep its trace.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Always the production server, locally and in CI, so both run the same
  // React scheduling. `npm run test:e2e` builds the package and the fixture
  // first; that script is the one place that decides a build exists. A server
  // already on the port is an error, not something to reuse silently.
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
