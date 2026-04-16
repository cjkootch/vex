import { defineConfig, devices } from "@playwright/test";

const PORT = 3001;

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: process.env["CI"] ? "github" : "list",
  retries: process.env["CI"] ? 1 : 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Sprint-5 chat is gated by middleware; tests run with auth disabled
    // via PLAYWRIGHT=1 (see middleware.ts conditional below).
    command: `PLAYWRIGHT=1 PORT=${PORT} pnpm dev`,
    url: `http://localhost:${PORT}/app/chat`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
