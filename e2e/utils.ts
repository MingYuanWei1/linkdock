import { execFileSync } from "node:child_process";
import { expect, request, type Browser, type Page } from "@playwright/test";
import { BASE_URL, E2E_PERSIST_DIR, E2E_SECRETS } from "./config";

export const { APP_PASSWORD, UPLOAD_KEY } = E2E_SECRETS;

// 预览请求会访问真实网络；.invalid 域名永远无法解析，因此这些链接的预览必然失败，
// 测试结果不依赖外部网站。预览成功的展示通过写入本地 D1 模拟（见 completePreview）。
let counter = 0;
export function uniqueUrl(label = "item"): string {
  counter += 1;
  return `https://e2e-${label}-${Date.now().toString(36)}-${counter}.invalid/article?id=${counter}`;
}

export async function signIn(page: Page, baseURL = BASE_URL): Promise<void> {
  await page.goto(baseURL + "/");
  await page.getByPlaceholder("访问密码").fill(APP_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByPlaceholder("粘贴链接，例如 https://mp.weixin.qq.com/s/…")).toBeVisible();
}

export async function newSignedInPage(browser: Browser, baseURL = BASE_URL): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, baseURL);
  return page;
}

export async function submitFromPage(page: Page, url: string): Promise<void> {
  await page.getByPlaceholder("粘贴链接，例如 https://mp.weixin.qq.com/s/…").fill(url);
  await page.getByRole("button", { name: "保存", exact: true }).click();
}

export function linkItems(page: Page) {
  return page.locator("#links > li");
}

export function itemFor(page: Page, text: string) {
  return linkItems(page).filter({ hasText: text });
}

// 模拟 iOS 快捷指令：只使用上传密钥调用公开接口。
export async function submitWithShortcut(url: string, key = UPLOAD_KEY, baseURL = BASE_URL) {
  const api = await request.newContext({ baseURL });
  const res = await api.post("/api/links", {
    headers: { Authorization: `Bearer ${key}` },
    data: { url },
  });
  const body = await res.json();
  await api.dispose();
  return { status: res.status(), body };
}

// 通过公开接口清空列表。本地实例是 http，请求客户端不会保存 Secure Cookie，因此手动携带。
export async function clearAllLinks(baseURL = BASE_URL): Promise<void> {
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const login = await api.post("/api/session", { data: { password: APP_PASSWORD } });
  expect(login.status()).toBe(204);
  const cookie = login.headers()["set-cookie"].split(";")[0];
  for (;;) {
    const res = await api.get("/api/links?limit=1000", { headers: { Cookie: cookie } });
    expect(res.status()).toBe(200);
    const { links } = (await res.json()) as { links: { id: string }[] };
    if (links.length === 0) break;
    for (const link of links) {
      await api.delete(`/api/links/${link.id}`, { headers: { Cookie: cookie } });
    }
  }
  await api.dispose();
}

// 直接写入本地 D1，模拟预览获取成功（并递增版本号，与服务端写入预览时的行为一致）。
export function completePreview(url: string, title: string, iconUrl: string | null): void {
  const esc = (s: string) => s.replace(/'/g, "''");
  const sql =
    `UPDATE links SET title = '${esc(title)}', icon_url = ${iconUrl ? `'${esc(iconUrl)}'` : "NULL"}, ` +
    `preview_status = 'ok' WHERE url = '${esc(url)}'; ` +
    `UPDATE meta SET value = value + 1 WHERE key = 'version';`;
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "linkdock", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", sql],
    { stdio: "pipe" },
  );
}
