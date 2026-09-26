import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  call,
  cookieFrom,
  login,
  ORIGIN,
  outboundRequests,
  sleep,
  submitWithKey,
  UPLOAD_KEY,
  type LinkView,
} from "./helpers";

let owner: string;
beforeEach(async () => {
  owner = await login();
});

const WECHAT = "https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa";

interface Status {
  available: boolean;
  connected: boolean;
  error: string | null;
  exported: number;
  failed: number;
}

async function microsoft(settings: Record<string, number>) {
  const qs = new URLSearchParams(Object.entries(settings).map(([k, v]) => [k, String(v)]));
  await fetch(`https://fixture.control/microsoft?${qs}`);
}

// 连接流程由跳转组成，测试逐步检查每次跳转，而不是自动跟随。
function navigate(path: string, cookie?: string): Promise<Response> {
  return call(path, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

function startConnect(cookie = owner): Promise<Response> {
  return navigate("/onenote/connect", cookie);
}

// 模拟完整的授权流程：回调来自 Microsoft 的跨站跳转，只带状态 Cookie，不带会话 Cookie。
async function connect(): Promise<void> {
  const start = await startConnect();
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  const done = await navigate(`/onenote/callback?code=good-code&state=${state}`, cookieFrom(start));
  expect(done.headers.get("Location")).toBe("/?onenote=connected");
}

async function status(cookie = owner): Promise<Status> {
  const res = await call("/api/onenote", { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return res.json();
}

async function save(url: string): Promise<LinkView> {
  return ((await (await submitWithKey(url)).json()) as { link: LinkView }).link;
}

async function exportRow(id: string) {
  return env.DB.prepare("SELECT * FROM onenote_exports WHERE link_id = ?").bind(id)
    .first<{ status: string; attempts: number; page_url: string | null; last_error: string | null }>();
}

async function waitForExport(id: string) {
  return vi.waitFor(async () => {
    const row = await exportRow(id);
    if (!row || row.status === "sending") throw new Error("尚未导出");
    return row;
  }, { timeout: 8000, interval: 50 });
}

async function waitForArticle(id: string) {
  await vi.waitFor(async () => {
    const row = await env.DB.prepare("SELECT 1 FROM articles WHERE link_id = ?").bind(id).first();
    if (!row) throw new Error("尚未存档");
  }, { timeout: 8000, interval: 50 });
}

async function runCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

async function pageRequests() {
  return (await outboundRequests()).filter((r) => r.url.startsWith("https://graph.microsoft.com/"));
}

async function tokenRequests() {
  return (await outboundRequests())
    .filter((r) => r.url.startsWith("https://login.microsoftonline.com/"))
    .map((r) => new URLSearchParams(r.body));
}

async function sha256base64url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("连接 OneNote", () => {
  it("跳转到个人 Microsoft 账户授权，只申请创建笔记与离线访问，并使用 PKCE", async () => {
    const start = await startConnect();
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("Location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("test-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/onenote/callback`);
    expect(authorize.searchParams.get("scope")).toBe("offline_access https://graph.microsoft.com/Notes.Create");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = start.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-linkdock_onenote=.+; Path=\/;.*HttpOnly; Secure; SameSite=Lax/);

    const state = authorize.searchParams.get("state")!;
    const done = await navigate(`/onenote/callback?code=good-code&state=${state}`, cookieFrom(start));
    expect(done.status).toBe(302);
    expect(done.headers.get("Location")).toBe("/?onenote=connected");
    expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const [token] = await tokenRequests();
    expect(token.get("grant_type")).toBe("authorization_code");
    expect(token.get("redirect_uri")).toBe(`${ORIGIN}/onenote/callback`);
    expect(await sha256base64url(token.get("code_verifier")!)).toBe(authorize.searchParams.get("code_challenge"));

    expect(await status()).toEqual({ available: true, connected: true, error: null, exported: 0, failed: 0 });
  });

  it("未登录时不能开始连接", async () => {
    const res = await navigate("/onenote/connect");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?onenote=login");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("state 不匹配或缺少状态 Cookie 时不换取令牌", async () => {
    const start = await startConnect();
    const wrong = await navigate("/onenote/callback?code=good-code&state=forged", cookieFrom(start));
    expect(wrong.headers.get("Location")).toBe("/?onenote=failed");
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const noCookie = await navigate(`/onenote/callback?code=good-code&state=${state}`);
    expect(noCookie.headers.get("Location")).toBe("/?onenote=failed");

    expect(await tokenRequests()).toHaveLength(0);
    expect((await status()).connected).toBe(false);
  });

  it("用户在 Microsoft 页面拒绝授权", async () => {
    const start = await startConnect();
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const res = await navigate(`/onenote/callback?error=access_denied&state=${state}`, cookieFrom(start));
    expect(res.headers.get("Location")).toBe("/?onenote=denied");
    expect((await status()).connected).toBe(false);
  });

  it("状态接口需要登录；上传密钥不能查看或断开", async () => {
    expect((await call("/api/onenote")).status).toBe(401);
    const withKey = { headers: { Authorization: `Bearer ${UPLOAD_KEY}` } };
    expect((await call("/api/onenote", withKey)).status).toBe(403);
    expect((await call("/api/onenote", { method: "DELETE", ...withKey })).status).toBe(403);
  });
});

describe("导出文章到 OneNote", () => {
  it("连接后保存的文章在后台创建为 OneNote 页面", async () => {
    await connect();
    const link = await save(WECHAT);
    const row = await waitForExport(link.id);
    expect(row.status).toBe("done");
    expect(row.page_url).toBe("https://onenote.example/page-1");

    const [page] = await pageRequests();
    expect(page.url).toBe("https://graph.microsoft.com/v1.0/me/onenote/pages?sectionName=LinkDock");
    expect(page.headers["authorization"]).toBe("Bearer access-1");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toContain("<title>公众号文章标题 &amp; 副标题</title>");
    expect(page.body).toContain(`原文：<a href="${WECHAT}">${WECHAT}</a>`);
    expect(page.body).toContain("第一段正文");
    expect(page.body).toContain('src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg"');
    expect(page.body).not.toContain("<script");

    expect(await status()).toMatchObject({ exported: 1, failed: 0 });
  });

  it("连接之前存档的文章不导出", async () => {
    const link = await save("https://site.example/reader-article");
    await waitForArticle(link.id);
    await sleep(5);
    await connect();
    await runCron();
    expect(await pageRequests()).toHaveLength(0);
    expect(await exportRow(link.id)).toBeNull();
  });

  it("重复提交与重新获取不会再次导出", async () => {
    await connect();
    const link = await save(WECHAT);
    await waitForExport(link.id);
    expect((await submitWithKey(WECHAT)).status).toBe(200);
    expect((await call(`/read/${link.id}?refresh=1`, { headers: { Cookie: owner } })).status).toBe(200);
    await sleep(300);
    await runCron();
    expect(await pageRequests()).toHaveLength(1);
  });

  it("导出失败时记录原因，由定时任务重试", async () => {
    await connect();
    await microsoft({ failPages: 1 });
    const link = await save(WECHAT);
    const failed = await waitForExport(link.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    expect(failed.last_error).toContain("503");

    await runCron();
    expect(await exportRow(link.id)).toMatchObject({ status: "done", attempts: 2 });
    expect(await pageRequests()).toHaveLength(2);
  });

  it("达到重试上限后不再尝试，并计入失败数", async () => {
    await connect();
    await microsoft({ failPages: 100 });
    const link = await save(WECHAT);
    await waitForExport(link.id);
    for (let i = 0; i < 6; i++) await runCron();
    expect(await exportRow(link.id)).toMatchObject({ status: "failed", attempts: 5 });
    expect(await pageRequests()).toHaveLength(5);
    expect(await status()).toMatchObject({ exported: 0, failed: 1 });
  });

  it("访问令牌到期前刷新，并保存轮换后的刷新令牌", async () => {
    await microsoft({ expiresIn: 60 });
    await connect();
    await waitForExport((await save(WECHAT)).id);
    await waitForExport((await save("https://site.example/reader-article")).id);

    const tokens = await tokenRequests();
    expect(tokens.map((t) => t.get("grant_type"))).toEqual(["authorization_code", "refresh_token", "refresh_token"]);
    expect(tokens[1].get("refresh_token")).toBe("refresh-1");
    expect(tokens[2].get("refresh_token")).toBe("refresh-2");
    expect(await pageRequests()).toHaveLength(2);
  });

  it("长时间没有导出时，定时任务刷新令牌以保持连接", async () => {
    await connect();
    await runCron();
    expect(await tokenRequests()).toHaveLength(1);

    await env.DB.prepare("UPDATE onenote_account SET access_expires = ?").bind(Date.now() - 8 * 86_400_000).run();
    await runCron();
    const tokens = await tokenRequests();
    expect(tokens.map((t) => t.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    const account = await env.DB.prepare("SELECT refresh_token FROM onenote_account").first<{ refresh_token: string }>();
    expect(account?.refresh_token).toBe("refresh-2");
  });

  it("授权失效时提示重新连接，重新连接后继续导出未完成的文章", async () => {
    await microsoft({ expiresIn: 60 });
    await connect();
    await microsoft({ rejectRefresh: 1 });
    const link = await save(WECHAT);
    expect(await waitForExport(link.id)).toMatchObject({ status: "failed", attempts: 0 });
    expect((await status()).error).toContain("重新连接");

    await runCron();
    expect(await pageRequests()).toHaveLength(0);

    await microsoft({ rejectRefresh: 0 });
    await connect();
    expect((await status()).error).toBeNull();
    await runCron();
    expect(await exportRow(link.id)).toMatchObject({ status: "done" });
    expect(await pageRequests()).toHaveLength(1);
  });

  it("断开连接后不再导出", async () => {
    await connect();
    const res = await call("/api/onenote", {
      method: "DELETE",
      headers: { Cookie: owner, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(204);
    expect((await status()).connected).toBe(false);

    const link = await save(WECHAT);
    await waitForArticle(link.id);
    await sleep(300);
    await runCron();
    expect(await pageRequests()).toHaveLength(0);
  });
});
