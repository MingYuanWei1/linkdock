import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, devCommand, E2E_PERSIST_DIR, E2E_PORT } from "./e2e/config";

export default defineConfig({
  testDir: "./e2e",
  // 测试共享同一个本地实例与同一个私有列表，按顺序执行。
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    locale: "zh-CN",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, testIgnore: /mobile|restart/ },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" }, testMatch: /mobile/ },
    { name: "restart", testMatch: /restart/ },
  ],
  webServer: {
    command: devCommand(E2E_PORT, E2E_PERSIST_DIR),
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
