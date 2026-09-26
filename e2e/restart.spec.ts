import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { devCommand } from "./config";
import { itemFor, signIn, submitWithShortcut, uniqueUrl } from "./utils";

// 独立的实例与数据目录：保存链接后停止并重新启动应用，确认数据仍在。
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const PERSIST = ".wrangler/e2e-restart-state";

function start(fresh: boolean): ChildProcess {
  const command = fresh
    ? devCommand(PORT, PERSIST)
    : devCommand(PORT, PERSIST).split(" && ").filter((c) => !c.startsWith("rm ")).join(" && ");
  return spawn("sh", ["-c", command], { stdio: "ignore", detached: true });
}

async function stop(proc: ChildProcess): Promise<void> {
  if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  await new Promise((r) => proc.once("exit", r));
}

async function waitUntilUp(): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return (await fetch(BASE + "/")).status;
      } catch {
        return 0;
      }
    }, { timeout: 90_000, intervals: [500] })
    .toBe(200);
}

test("重新启动应用后条目仍然存在", async ({ page }) => {
  test.setTimeout(240_000);
  let server = start(true);
  try {
    await waitUntilUp();
    const url = uniqueUrl("restart");
    expect((await submitWithShortcut(url, undefined, BASE)).status).toBe(201);

    await stop(server);
    server = start(false);
    await waitUntilUp();

    await signIn(page, BASE);
    await expect(itemFor(page, url)).toHaveCount(1);
  } finally {
    await stop(server);
  }
});
