import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_SECRETS } from "./test/secrets.ts";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ...TEST_SECRETS,
          FETCH_TIMEOUT_MS: "1500",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        // 出站请求全部交给可控的测试网站，不访问真实网络。
        outboundService: "external-sites",
        workers: [
          {
            name: "external-sites",
            modules: true,
            scriptPath: "./test/fixtures/external-sites.js",
            compatibilityDate: "2026-08-01",
          },
        ],
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 15_000,
  },
});
