import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The deck is a long-lived dev server owned by scripts/starra; Playwright
  // must NOT try to start or stop it.
  use: {
    baseURL: "https://localhost:3000",
    ignoreHTTPSErrors: true, // mkcert CA is in the System keychain, not Chromium's
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    // storageState: undefined does not override the base config (Playwright's
    // project/use merge drops explicit undefined), so the setup test would try
    // to read e2e/.auth/user.json before it exists. Start it from a fresh,
    // empty storage state instead.
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { storageState: { cookies: [], origins: [] } } },
    { name: "deck", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  expect: {
    // Anti-aliasing on a canvas starfield makes byte-exact comparison useless.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" },
  },
  reporter: [["list"]],
  forbidOnly: true,
  workers: 1,
});
