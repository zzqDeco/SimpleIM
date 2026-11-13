import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const LOCAL_MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const executablePath =
  !process.env.CI && existsSync(LOCAL_MAC_CHROME)
    ? LOCAL_MAC_CHROME
    : undefined;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    headless: true,
    trace: "retain-on-failure",
    browserName: "chromium",
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    },
  },
});
