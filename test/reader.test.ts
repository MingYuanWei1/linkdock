import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  deleteRequest,
  login,
  outboundRequests,
  submitWithKey,
  UPLOAD_KEY,
  type LinkView,
} from "./helpers";

let owner: string;
beforeEach(async () => {
  owner = await login();
});

async function save(url: string): Promise<LinkView> {
  const res = await submitWithKey(url);
  return ((await res.json()) as { link: LinkView }).link;
}

function read(id: string, cookie: string | null = owner): Promise<Response> {
  return call(`/read/${id}`, { headers: cookie ? { Cookie: cookie } : {} });
}

const WECHAT = "https://mp.weixin.qq.com/s/Xk3pQ9wRZtY2mNvB7cLdEa";

describe("阅读视图：微信公众号文章", () => {
  it("显示标题、公众号名称与正文，隐藏样式被移除，图片使用真实地址", async () => {
    const res = await read((await save(WECHAT)).id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const page = await res.text();

    expect(page).toContain("<h1>公众号文章标题 &amp; 副标题</h1>");
    expect(page).toContain("示例公众号 · mp.weixin.qq.com");
    expect(page).toContain("第一段正文");
    expect(page).toContain("列表二");
    expect(page).toContain("自定义元素中的文字");
    expect(page).toMatch(/<img [^>]*src="https:\/\/mmbiz\.qpic\.cn\/mmbiz_jpg\/abc\/640\?wx_fmt=jpeg"/);
    expect(page).toContain('referrerpolicy="no-referrer"');
    expect(page).toContain('alt="配图"');
    expect(page).not.toMatch(/visibility:\s*hidden/);
    expect(page).not.toMatch(/opacity:\s*0/);
    // 正文之外的页面元素不出现
    expect(page).not.toContain("微信扫一扫");
    expect(page).not.toContain("var msg_title");
  });

  it("移除脚本、事件属性、危险链接、框架、SVG、表单与外部样式资源", async () => {
    const page = await (await read((await save(WECHAT)).id)).text();
    for (const forbidden of [
      "<script", "window.__xss", "onerror", "javascript:", "<iframe", "v.qq.com",
      "<svg", "svg 文本", "<form", "<input", "<button", "evil.example",
      "tracker.example", "url(", "position: fixed", "data:image/svg",
    ]) {
      expect(page, forbidden).not.toContain(forbidden);
    }
    expect(page).toContain("第三段加粗");
    expect(page).toContain("font-weight: bold");
    expect(page).toContain(
      '<a href="https://example.org/ref?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">参考链接</a>',
    );
    expect(page).toContain("<a>恶意链接</a>");
  });

  it("响应禁止脚本、以沙箱运行，只允许本站嵌入", async () => {
    const res = await read((await save(WECHAT)).id);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(csp).toContain("sandbox allow-popups allow-popups-to-escape-sandbox");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("底部提供打开原网页的链接", async () => {
    const page = await (await read((await save(WECHAT)).id)).text();
    expect(page).toContain(`<a href="${WECHAT}" target="_blank" rel="noopener noreferrer">打开原网页</a>`);
  });

  it("微信返回错误页时给出说明与打开原网页", async () => {
    const url = "https://mp.weixin.qq.com/s/ErrorPageSample0001";
    const res = await read((await save(url)).id);
    expect(res.status).toBe(502);
    const page = await res.text();
    expect(page).toContain("无法在此显示这篇文章");
    expect(page).toContain("微信没有返回文章内容");
    // 页内不提供会产生 iframe 历史记录的重试链接。
    expect(page).not.toContain('href=""');
    expect(page).toContain(`href="${url}"`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("阅读视图：普通网页", () => {
  it("优先提取 article，丢弃导航、侧栏、页脚和原始文本中的脚本", async () => {
    const page = await (await read((await save("https://site.example/reader-article")).id)).text();
    expect(page).toContain("普通文章标题");
    expect(page).toContain("这是一篇普通网站的文章正文");
    expect(page).toContain('src="https://site.example/images/photo.jpg"');
    expect(page).toContain('href="https://site.example/related"');
    expect(page).toContain("点击事件被移除");
    for (const forbidden of ["首页", "侧边栏广告", "页脚版权信息", "window.__xss", "onclick", "<xmp", "<noscript"]) {
      expect(page, forbidden).not.toContain(forbidden);
    }
  });

  it("没有 article / main 时使用 body", async () => {
    const page = await (await read((await save("https://site.example/reader-body")).id)).text();
    expect(page).toContain("这个页面没有 article 或 main 元素");
  });

  it.each([
    ["脚本渲染、没有正文", "https://site.example/reader-empty", "页面没有可显示的正文"],
    ["请求超时", "https://site.example/hang", "请求超时"],
    ["HTTP 错误", "https://site.example/error", "HTTP 500"],
    ["非网页内容", "https://site.example/pdf", "不是网页内容"],
    ["重定向到内网", "https://site.example/redirect-internal", "目标地址不是公网网页"],
    ["内网地址", "http://192.168.1.1/", "目标地址不是公网网页"],
  ])("%s：返回说明页和打开原网页", async (_name, url, reason) => {
    const res = await read((await save(url)).id);
    expect(res.status).toBe(502);
    const page = await res.text();
    expect(page).toContain(reason);
    expect(page).toContain("打开原网页");
  });
});

describe("阅读视图权限", () => {
  it("未登录、只有上传密钥或伪造会话时不能读取", async () => {
    const link = await save(WECHAT);
    const anonymous = await read(link.id, null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("第一段正文");

    const withKey = await call(`/read/${link.id}`, { headers: { Authorization: `Bearer ${UPLOAD_KEY}` } });
    expect(withKey.status).toBe(401);
    expect((await read(link.id, "__Host-linkdock_session=v1.9999999999999.AAAA")).status).toBe(401);
  });

  it("只能读取已保存的链接；删除后不可读取", async () => {
    expect((await read("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const link = await save(WECHAT);
    await deleteRequest(owner, link.id);
    expect((await read(link.id)).status).toBe(404);
  });

  it("抓取文章时不携带登录 Cookie", async () => {
    await read((await save("https://site.example/reader-article")).id);
    const requests = (await outboundRequests()).filter((r) => r.url.endsWith("/reader-article"));
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });
});
