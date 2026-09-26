import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM onenote_exports"),
    env.DB.prepare("DELETE FROM onenote_account"),
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM login_failures"),
    env.DB.prepare("UPDATE meta SET value = 0 WHERE key = 'version'"),
  ]);
  await fetch("https://fixture.control/reset");
});
