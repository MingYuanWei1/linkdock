import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteRequest,
  list,
  login,
  outboundRequests,
  sleep,
  submitWithKey,
  submitWithSession,
  UPLOAD_KEY,
  waitForPreview,
  type LinkView,
} from "./helpers";

let owner: string;
beforeEach(async () => {
  owner = await login();
});

async function save(url: string): Promise<LinkView> {
  const res = await submitWithKey(url);
  expect(res.status).toBe(201);
  return ((await res.json()) as { link: LinkView }).link;
}

describe("预览成功", () => {
  it("显示 og:title 与网站图标，实体按文本解码", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/article")).id);
    expect(link.previewStatus).toBe("ok");
    expect(link.title).toBe("Example & Co 示例文章");
    expect(link.iconUrl).toBe("https://site.example/static/icon.png");
  });

  it("没有 og:title 时使用 <title>，并整理空白", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/title-only")).id);
    expect(link.title).toBe("Only a <title>");
  });

  it("没有声明图标时回退到 /favicon.ico", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/no-icon")).id);
    expect(link.iconUrl).toBe("https://site.example/favicon.ico");
  });

  it("跟随公网重定向，图标按最终地址解析", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/redirect")).id);
    expect(link.previewStatus).toBe("ok");
    expect(link.iconUrl).toBe("https://site.example/static/icon.png");
    expect(link.url).toBe("https://site.example/redirect");
  });

  it("按响应声明的 GBK 编码解码中文标题", async () => {
    const link = await waitForPreview(owner, (await save("https://gbk.example/")).id);
    expect(link.title).toBe("中文标题");
  });

  it("预览标题可被搜索", async () => {
    await waitForPreview(owner, (await save("https://site.example/article")).id);
    expect((await list(owner, "示例文章")).links).toHaveLength(1);
  });

  it("元数据中的标记只作为文本保存，危险的图标地址被丢弃", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/xss")).id);
    expect(link.title).toBe('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
    expect(link.iconUrl).toBe("https://site.example/favicon.ico");
  });

  it("公众号文章：使用 og:title 与微信图标", async () => {
    const link = await waitForPreview(
      owner,
      (await save("https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa")).id,
    );
    expect(link.title).toBe("公众号文章标题 & 副标题");
    expect(link.iconUrl).toBe("https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico");
  });
});

describe("预览失败只显示原链接", () => {
  it.each([
    ["HTTP 错误", "https://site.example/error"],
    ["非网页内容", "https://site.example/pdf"],
    ["页面无标题", "https://site.example/no-title"],
    ["请求超时", "https://site.example/hang"],
    ["重定向到内网地址", "https://site.example/redirect-internal"],
    ["重定向循环", "https://site.example/redirect-loop"],
    ["标题超出读取上限", "https://site.example/huge"],
    ["未知主机", "https://unreachable.example/"],
    ["微信验证页", "https://mp.weixin.qq.com/s/VerifyPageSample0001"],
  ])("%s", async (_name, url) => {
    const link = await waitForPreview(owner, (await save(url)).id);
    expect(link.previewStatus).toBe("failed");
    expect(link.title).toBeNull();
    expect(link.iconUrl).toBeNull();
    expect(link.url).toBe(url);
    // 失败的条目仍可删除。
    expect((await deleteRequest(owner, link.id)).status).toBe(204);
  });

  it("内网与本机地址不会被请求", async () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "http://localhost:8787/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://printer.local/",
    ]) {
      const link = await waitForPreview(owner, (await save(url)).id);
      expect(link.previewStatus).toBe("failed");
    }
    await waitForPreview(owner, (await save("https://site.example/redirect-internal")).id);
    const hosts = (await outboundRequests()).map((r) => new URL(r.url).hostname);
    expect(hosts.every((h) => h === "site.example")).toBe(true);
  });
});

describe("预览请求的隐私", () => {
  it("不向目标网站发送登录 Cookie 或上传密钥", async () => {
    await submitWithSession(owner, "https://site.example/article?via=session");
    await submitWithKey("https://site.example/article?via=key");
    await waitForPreview(owner, (await list(owner)).links[0].id);
    await waitForPreview(owner, (await list(owner)).links[1].id);

    const requests = await outboundRequests();
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      const headers = JSON.stringify(r.headers);
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      expect(headers).not.toContain(UPLOAD_KEY);
      expect(headers).not.toContain(owner.split("=")[1]);
    }
  });
});

describe("预览与条目生命周期", () => {
  it("预览完成前删除条目，迟到的预览结果不会让条目重新出现", async () => {
    const link = await save("https://site.example/article?delay=600");
    expect((await deleteRequest(owner, link.id)).status).toBe(204);
    await sleep(1200);
    expect((await list(owner)).links).toHaveLength(0);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("重复提交不会把已有的有效预览覆盖为失败", async () => {
    const link = await waitForPreview(owner, (await save("https://site.example/article")).id);
    expect(link.previewStatus).toBe("ok");
    // 模拟之后预览会失败的情况：直接写入失败结果。
    const { savePreviewFailure } = await import("../src/links");
    await savePreviewFailure(env.DB, link.id);
    const again = await submitWithKey("https://site.example/article");
    expect(again.status).toBe(200);
    const after = (await list(owner)).links[0];
    expect(after.previewStatus).toBe("ok");
    expect(after.title).toBe("Example & Co 示例文章");
  });

  it("重复提交会为失败的条目重新尝试获取预览", async () => {
    // 先以失败状态保存（预览超时），随后把条目改为指向同一身份但可成功的情形由数据库直接模拟。
    const link = await waitForPreview(owner, (await save("https://site.example/no-title")).id);
    expect(link.previewStatus).toBe("failed");
    await env.DB.prepare("UPDATE links SET url = 'https://site.example/article' WHERE id = ?")
      .bind(link.id)
      .run();
    await submitWithKey("https://site.example/no-title");
    await expect
      .poll(async () => (await list(owner)).links[0].previewStatus, { timeout: 5000, interval: 50 })
      .toBe("ok");
  });

  it("预览补全会改变列表版本，让轮询方获取到标题", async () => {
    const link = await save("https://site.example/article?delay=300");
    const before = await list(owner);
    expect(before.links[0].previewStatus).toBe("pending");
    await waitForPreview(owner, link.id);
    const after = await list(owner);
    expect(after.version).toBeGreaterThan(before.version);
  });
});
