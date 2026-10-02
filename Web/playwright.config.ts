import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Runs against a production build (npm run test:e2e builds first) with a
// throwaway data directory, wiped at server start so every run begins empty.
const PORT = 3100;
// The real SaveAllResources installation for the template-generation e2e
// test: SAR_HOME, or a sibling checkout. Unset means those tests are skipped.
export const E2E_SAR_HOME = process.env.SAR_HOME ?? (existsSync(resolve(__dirname, "../SaveAllResources/app/cli.mjs")) ? resolve(__dirname, "../SaveAllResources") : "");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1, // one SQLite file; specs build on a known starting state
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .e2e-data && next start -p ${PORT}`,
    url: `http://localhost:${PORT}/projects`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      SCL_DATA_DIR: ".e2e-data",
      APP_BASE_URL: "https://scl-e2e.invalid",
      // Production server, so the no-sign-in guard must be opted out of.
      DASHBOARD_ALLOW_UNAUTHENTICATED: "true",
      // SaveAllResources capture: the extension id is fixed by its manifest key;
      // the e2e extension build (.sar-extension) allows this origin.
      SAR_EXTENSION_ID: "jfpfjjalojpaffneaemkcjbdnmbaognl",
      SAR_UPLOAD_ORIGIN: `http://localhost:${PORT}`,
      SAR_HOME: E2E_SAR_HOME,
      // Live template previews run as local processes in the e2e run too.
      PREVIEW_MODE: "local",
    },
  },
});
