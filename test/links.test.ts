import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  deleteRequest,
  list,
  listRequest,
  login,
  submitWithKey,
  type LinkView,
} from "./helpers";

let owner: string;
beforeEach(async () => {
  owner = await login();
});

async function submitted(res: Response): Promise<{ created: boolean; link: LinkView; message: string }> {
  return res.json();
}

describe("提交与列表", () => {
  it("快捷指令提交成功后，接收设备可以看到唯一条目", async () => {
    const res = await submitWithKey("https://site.example/no-icon");
    expect(res.status).toBe(201);
    const { links } = await list(owner);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://site.example/no-icon");
  });

  it("保存成功后条目已持久化（直接查询数据库）", async () => {
    const { link } = await submitted(await submitWithKey("https://site.example/no-icon"));
    const row = await env.DB.prepare("SELECT url FROM links WHERE id = ?").bind(link.id).first();
    expect(row).toEqual({ url: "https://site.example/no-icon" });
  });

  it("最近提交的链接排在最前", async () => {
    for (const path of ["a", "b", "c"]) await submitWithKey(`https://site.example/${path}`);
    expect((await list(owner)).links.map((l) => l.url)).toEqual([
      "https://site.example/c",
      "https://site.example/b",
      "https://site.example/a",
    ]);
  });

  it("保存不等待预览：慢速网页也能立即返回", async () => {
    const started = Date.now();
    const res = await submitWithKey("https://site.example/hang");
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await submitted(res)).link.previewStatus).toBe("pending");
  });

  it.each([
    ["", "请提供链接"],
    ["   ", "请提供链接"],
    ["not a url", "链接中不能包含空格或换行"],
    ["example.com/article", "不是有效的网页链接"],
    ["javascript:alert(1)", "只支持 http 或 https 网页链接"],
    ["ftp://example.com/file", "只支持 http 或 https 网页链接"],
    ["data:text/html,hi", "只支持 http 或 https 网页链接"],
    ["https://user:pass@example.com/", "链接中不能包含用户名或密码"],
    ["https://example.com/" + "a".repeat(5000), "链接过长"],
  ])("拒绝无效输入 %j", async (input, message) => {
    const res = await submitWithKey(input);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(message);
    expect((await list(owner)).links).toHaveLength(0);
  });

  it("拒绝非字符串与缺失字段", async () => {
    expect((await submitWithKey(42)).status).toBe(400);
    expect((await submitWithKey(null)).status).toBe(400);
    expect((await list(owner)).links).toHaveLength(0);
  });

  it("提交前后的空白被去除", async () => {
    const res = await submitWithKey("  https://site.example/no-icon\n");
    expect(res.status).toBe(201);
    expect((await list(owner)).links[0].url).toBe("https://site.example/no-icon");
  });
});

describe("重复提交", () => {
  it("同一链接再次提交只保留一个条目并移到顶部", async () => {
    const first = await submitted(await submitWithKey("https://site.example/a"));
    await submitWithKey("https://site.example/b");
    const again = await submitWithKey("https://site.example/a");

    expect(again.status).toBe(200);
    const body = await submitted(again);
    expect(body.created).toBe(false);
    expect(body.message).toContain("已移到顶部");
    expect(body.link.id).toBe(first.link.id);
    expect(body.link.firstSavedAt).toBe(first.link.firstSavedAt);

    const { links } = await list(owner);
    expect(links.map((l) => l.url)).toEqual(["https://site.example/a", "https://site.example/b"]);
  });

  it("并发提交同一链接只产生一个条目", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => submitWithKey("https://site.example/concurrent")),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await list(owner)).links).toHaveLength(1);
  });

  it("只有跟踪参数、空片段或主机名大小写不同的链接视为同一条", async () => {
    await submitWithKey("https://Site.Example/page?id=7");
    await submitWithKey("https://site.example:443/page?id=7&utm_source=twitter#");
    await submitWithKey("https://site.example/page?utm_medium=social&id=7&utm_campaign=x");
    expect((await list(owner)).links).toHaveLength(1);
  });

  it("有意义的差异不会被误合并", async () => {
    const distinct = [
      "https://site.example/page?id=7",
      "https://site.example/page?id=8",
      "https://site.example/page",
      "https://site.example/page/",
      "https://site.example/Page?id=7",
      "http://site.example/page?id=7",
      "https://site.example/page?id=7#section-2",
      "https://site.example/app#/route/1",
      "https://site.example/app#/route/2",
      "https://other.example/page?id=7",
    ];
    for (const url of distinct) await submitWithKey(url);
    expect((await list(owner)).links).toHaveLength(distinct.length);
  });
});

describe("微信公众号文章身份", () => {
  // 样本格式来自公众号文章的公开分享链接：短链 /s/<文章标识>，
  // 以及包含 __biz、mid、idx、sn 的长链（分享后常附加 chksm、scene 等参数和 #rd / #wechat_redirect）。
  const BIZ = "MzA5NzAzNjI1Ng==";
  const longLink = (extra: string, hash = "") =>
    `https://mp.weixin.qq.com/s?__biz=${BIZ}&mid=2650612345&idx=1&sn=0a1b2c3d4e5f60718293a4b5c6d7e8f9${extra}${hash}`;

  it("长链：分享参数、校验参数、片段与 http/https 不同仍视为同一篇", async () => {
    await submitWithKey(longLink(""));
    await submitWithKey(longLink("&chksm=8b1c2d3e4f&scene=21", "#wechat_redirect"));
    await submitWithKey(longLink("&chksm=ffffeeee&scene=126&sessionid=1727330000", "#rd"));
    await submitWithKey(longLink("&scene=0").replace("https:", "http:"));
    await submitWithKey(longLink("").replace(`__biz=${BIZ}`, `__biz=${encodeURIComponent(BIZ)}`));
    const { links } = await list(owner);
    expect(links).toHaveLength(1);
    // 保留首次提交时的原链接。
    expect(links[0].url).toBe(longLink(""));
  });

  it("长链：同一公众号的不同文章（idx、mid 或 sn 不同）不合并", async () => {
    await submitWithKey(longLink(""));
    await submitWithKey(longLink("").replace("idx=1", "idx=2"));
    await submitWithKey(longLink("").replace("mid=2650612345", "mid=2650612346"));
    await submitWithKey(longLink("").replace("sn=0a1b", "sn=ffff"));
    expect((await list(owner)).links).toHaveLength(4);
  });

  it("短链：查询参数与片段不同仍视为同一篇", async () => {
    await submitWithKey("https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa");
    await submitWithKey("https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa?scene=1&poc_token=HABC");
    await submitWithKey("http://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa#rd");
    await submitWithKey("https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa/");
    expect((await list(owner)).links).toHaveLength(1);
  });

  it("短链大小写不同、短链与长链之间都不合并", async () => {
    await submitWithKey("https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa");
    await submitWithKey("https://mp.weixin.qq.com/s/xk3pq9wrztY2mNvB7cLdEa");
    await submitWithKey(longLink(""));
    expect((await list(owner)).links).toHaveLength(3);
  });

  it("缺少文章标识的微信链接只按通用规则处理", async () => {
    await submitWithKey(`https://mp.weixin.qq.com/s?__biz=${BIZ}&mid=1&idx=1&scene=1`);
    await submitWithKey(`https://mp.weixin.qq.com/s?__biz=${BIZ}&mid=1&idx=1&scene=2`);
    expect((await list(owner)).links).toHaveLength(2);
  });
});

describe("搜索", () => {
  it("按网址搜索，不区分英文大小写；无结果返回空列表", async () => {
    await submitWithKey("https://site.example/Alpha-Story");
    await submitWithKey("https://other.example/beta");

    expect((await list(owner, "alpha")).links.map((l) => l.url)).toEqual([
      "https://site.example/Alpha-Story",
    ]);
    expect((await list(owner, "OTHER.example")).links).toHaveLength(1);
    expect((await list(owner, "不存在的内容")).links).toEqual([]);
  });

  it("搜索词中的 % 与 _ 按字面匹配", async () => {
    await submitWithKey("https://site.example/a_b");
    await submitWithKey("https://site.example/axb");
    expect((await list(owner, "a_b")).links).toHaveLength(1);
    expect((await list(owner, "%")).links).toHaveLength(0);
  });
});

describe("删除", () => {
  it("删除后从列表消失，重复删除返回 404", async () => {
    const { link } = await submitted(await submitWithKey("https://site.example/a"));
    await submitWithKey("https://site.example/b");
    expect((await deleteRequest(owner, link.id)).status).toBe(204);
    expect((await list(owner)).links.map((l) => l.url)).toEqual(["https://site.example/b"]);
    expect((await deleteRequest(owner, link.id)).status).toBe(404);
  });

  it("删除后再次提交会作为新条目保存", async () => {
    const first = await submitted(await submitWithKey("https://site.example/a"));
    await deleteRequest(owner, first.link.id);
    const again = await submitWithKey("https://site.example/a");
    expect(again.status).toBe(201);
    expect((await submitted(again)).link.id).not.toBe(first.link.id);
  });
});

describe("变化检测（轮询）", () => {
  it("列表未变化时返回 304，提交、删除后 ETag 改变", async () => {
    const first = await listRequest(owner);
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();

    const unchanged = await listRequest(owner, "", { headers: { "If-None-Match": etag } });
    expect(unchanged.status).toBe(304);

    const { link } = await submitted(await submitWithKey("https://site.example/no-title"));
    const afterSubmit = await listRequest(owner, "", { headers: { "If-None-Match": etag } });
    expect(afterSubmit.status).toBe(200);
    const etag2 = afterSubmit.headers.get("ETag")!;

    await deleteRequest(owner, link.id);
    const afterDelete = await listRequest(owner, "", { headers: { "If-None-Match": etag2 } });
    expect(afterDelete.status).toBe(200);
    expect(((await afterDelete.json()) as { links: unknown[] }).links).toHaveLength(0);
  });

  it("不同的搜索词不会共用 ETag", async () => {
    await submitWithKey("https://site.example/a");
    const all = await listRequest(owner);
    const searched = await listRequest(owner, "zzz", {
      headers: { "If-None-Match": all.headers.get("ETag")! },
    });
    expect(searched.status).toBe(200);
  });

  it("limit 控制返回数量并标记是否还有更多", async () => {
    for (let i = 0; i < 5; i++) await submitWithKey(`https://site.example/n${i}`);
    expect((await list(owner)).hasMore).toBe(false);

    const page = await call("/api/links?limit=2", { headers: { Cookie: owner } });
    const body = (await page.json()) as { links: LinkView[]; hasMore: boolean };
    expect(body.links.map((l) => l.url)).toEqual(["https://site.example/n4", "https://site.example/n3"]);
    expect(body.hasMore).toBe(true);
  });
});
