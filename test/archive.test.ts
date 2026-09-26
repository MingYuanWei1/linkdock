import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveArticle } from "../src/links";
import {
  call,
  deleteRequest,
  list,
  login,
  outboundRequests,
  sleep,
  submitWithKey,
  waitForPreview,
  type LinkView,
} from "./helpers";

let owner: string;
beforeEach(async () => {
  owner = await login();
});

const WECHAT = "https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa";

async function save(url: string): Promise<LinkView> {
  return ((await (await submitWithKey(url)).json()) as { link: LinkView }).link;
}

function read(id: string, refresh = false): Promise<Response> {
  return call(`/read/${id}${refresh ? "?refresh=1" : ""}`, { headers: { Cookie: owner } });
}

async function article(id: string) {
  return env.DB.prepare("SELECT * FROM articles WHERE link_id = ?").bind(id)
    .first<{ content_html: string; saved_at: number; title: string | null }>();
}

async function waitForArticle(id: string) {
  return vi.waitFor(async () => {
    const row = await article(id);
    if (!row) throw new Error("尚未存档");
    return row;
  }, { timeout: 8000, interval: 50 });
}

async function resetOutbound() {
  await fetch("https://fixture.control/reset");
}

async function requestsTo(fragment: string) {
  return (await outboundRequests()).filter((r) => r.url.includes(fragment));
}

describe("保存时存档正文", () => {
  it("提交后在后台存档；之后打开直接显示存档，不再访问原网站", async () => {
    const link = await save(WECHAT);
    await waitForArticle(link.id);
    await resetOutbound();

    const res = await read(link.id);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("第一段正文");
    expect(page).toContain("保存的阅读版本");
    expect(await outboundRequests()).toHaveLength(0);
  });

  it("一次抓取同时完成预览与存档", async () => {
    const link = await save("https://site.example/reader-article");
    await waitForArticle(link.id);
    const withPreview = await waitForPreview(owner, link.id);
    expect(withPreview.title).toBe("普通文章");
    expect(await requestsTo("/reader-article")).toHaveLength(1);
  });

  it("重复提交已存档的链接不会再次抓取", async () => {
    const link = await save(WECHAT);
    await waitForArticle(link.id);
    await waitForPreview(owner, link.id);
    await resetOutbound();
    expect((await submitWithKey(WECHAT)).status).toBe(200);
    await sleep(300);
    expect(await outboundRequests()).toHaveLength(0);
  });

  it("重复提交尚未存档的链接会补做存档", async () => {
    const link = await save("https://site.example/reader-article");
    await waitForArticle(link.id);
    await env.DB.prepare("DELETE FROM articles WHERE link_id = ?").bind(link.id).run();
    await submitWithKey("https://site.example/reader-article");
    await waitForArticle(link.id);
  });

  it("存档失败不影响预览；打开时显示说明", async () => {
    const link = await save("https://site.example/reader-empty");
    const withPreview = await waitForPreview(owner, link.id);
    expect(withPreview.title).toBe("脚本渲染的页面");
    expect(await article(link.id)).toBeNull();
    expect((await read(link.id)).status).toBe(502);
  });
});

describe("首次打开时存档", () => {
  it("没有存档的旧链接在第一次打开时存档，之后不再抓取", async () => {
    const link = await save("https://site.example/reader-article");
    await waitForArticle(link.id);
    await env.DB.prepare("DELETE FROM articles WHERE link_id = ?").bind(link.id).run();
    await resetOutbound();

    const first = await read(link.id);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("这是一篇普通网站的文章正文");
    expect(await requestsTo("/reader-article")).toHaveLength(1);
    expect(await article(link.id)).not.toBeNull();

    await read(link.id);
    expect(await requestsTo("/reader-article")).toHaveLength(1);
  });

  it("正文超过存档上限时仍然显示，但不存档", async () => {
    const link = await save("https://site.example/reader-long");
    await waitForPreview(owner, link.id);
    const res = await read(link.id);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("未存档");
    expect(await article(link.id)).toBeNull();
  });
});

describe("重新获取", () => {
  it("重新抓取并更新存档", async () => {
    const link = await save("https://site.example/reader-article");
    const before = await waitForArticle(link.id);
    await env.DB.prepare("UPDATE articles SET content_html = '<p>旧版本内容</p>', saved_at = 1 WHERE link_id = ?")
      .bind(link.id).run();
    expect(await (await read(link.id)).text()).toContain("旧版本内容");

    const res = await read(link.id, true);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("这是一篇普通网站的文章正文");
    expect(page).not.toContain("旧版本内容");
    const after = await article(link.id);
    expect(after!.saved_at).toBeGreaterThanOrEqual(before.saved_at);
    expect(after!.content_html).not.toContain("旧版本内容");
  });

  it("重新获取失败时保留并显示原存档，附带说明", async () => {
    const link = await save("https://site.example/error");
    await waitForPreview(owner, link.id);
    await saveArticle(env.DB, {
      link_id: link.id,
      title: "早先保存的标题",
      byline: null,
      content_html: "<p>早先保存的正文</p>",
      source_url: "https://site.example/error",
    }, Date.UTC(2026, 8, 1, 4, 30));

    const res = await read(link.id, true);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("重新获取失败（HTTP 500）");
    expect(page).toContain("早先保存的正文");
    expect(page).toContain("2026年9月1日 12:30"); // 按中国时区显示
    expect((await article(link.id))!.content_html).toBe("<p>早先保存的正文</p>");

    const normal = await (await read(link.id)).text();
    expect(normal).toContain("早先保存的正文");
    expect(normal).not.toContain("重新获取失败");
  });
});

describe("删除", () => {
  it("删除条目时同时删除存档", async () => {
    const link = await save(WECHAT);
    await waitForArticle(link.id);
    expect((await deleteRequest(owner, link.id)).status).toBe(204);
    expect(await article(link.id)).toBeNull();
  });

  it("抓取完成前删除条目，迟到的结果不会留下存档或重新创建条目", async () => {
    const link = await save("https://site.example/reader-article?delay=600");
    expect((await deleteRequest(owner, link.id)).status).toBe(204);
    await sleep(1200);
    expect(await article(link.id)).toBeNull();
    expect((await list(owner)).links).toHaveLength(0);
  });
});
