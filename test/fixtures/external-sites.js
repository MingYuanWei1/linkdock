// 可控的“外部网站”：测试中 LinkDock Worker 的所有出站请求都由这里应答。
// 访问 https://fixture.control/requests 可查看收到的请求（用于断言请求头与访问目标）。

const requests = [];

const WECHAT_ARTICLE = (title) => `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta property="og:title" content="${title}" />
<meta property="og:type" content="article" />
<link rel="shortcut icon" type="image/x-icon" href="//res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico" />
<title></title>
</head><body><div id="js_content">正文</div></body></html>`;

function html(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.hostname === "fixture.control") {
      if (url.pathname === "/requests") return Response.json(requests);
      if (url.pathname === "/reset") {
        requests.length = 0;
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    }

    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
    });

    if (url.hostname === "mp.weixin.qq.com") {
      if (url.pathname === "/s/VerifyPageSample0001") {
        // 模拟验证页：没有 og:title。
        return html("<html><head><title>环境异常</title></head><body>完成验证后即可继续访问</body></html>");
      }
      return html(WECHAT_ARTICLE("公众号文章标题 &amp; 副标题"));
    }

    if (url.hostname === "gbk.example") {
      // “中文标题” 的 GBK 编码
      const title = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]);
      const head = new TextEncoder().encode("<html><head><title>");
      const tail = new TextEncoder().encode("</title></head><body></body></html>");
      const body = new Uint8Array(head.length + title.length + tail.length);
      body.set(head, 0);
      body.set(title, head.length);
      body.set(tail, head.length + title.length);
      return new Response(body, { headers: { "Content-Type": "text/html; charset=gbk" } });
    }

    if (url.hostname !== "site.example") return new Response("unknown host", { status: 502 });

    const delay = Number(url.searchParams.get("delay") ?? 0);
    if (delay) await sleep(delay);

    switch (url.pathname) {
      case "/article":
      case "/final":
        return html(`<!doctype html><html><head>
          <title>Document Title</title>
          <meta property="og:title" content="Example &amp; Co 示例文章">
          <link rel="apple-touch-icon" href="/apple.png">
          <link rel="icon" href="/static/icon.png">
          </head><body>hello</body></html>`);
      case "/title-only":
        return html("<html><head><title>\n  Only   a &lt;title&gt;  </title></head></html>");
      case "/no-icon":
        return html("<html><head><title>No Icon Page</title></head></html>");
      case "/xss":
        return html(`<html><head>
          <meta property="og:title" content="&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;&lt;script&gt;window.__xss=2&lt;/script&gt;">
          <link rel="icon" href="javascript:alert(1)">
          </head></html>`);
      case "/no-title":
        return html("<html><head></head><body>nothing</body></html>");
      case "/error":
        return html("<h1>boom</h1>", { status: 500 });
      case "/pdf":
        return new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
      case "/hang":
        await sleep(60_000);
        return html("<title>too late</title>");
      case "/redirect":
        return new Response(null, { status: 302, headers: { Location: "/final" } });
      case "/redirect-internal":
        return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } });
      case "/redirect-loop":
        return new Response(null, { status: 302, headers: { Location: "/redirect-loop" } });
      case "/huge": {
        // 标题位于 1 MiB 之后，超出读取上限。
        const filler = "<!-- " + "x".repeat(2 * 1024 * 1024) + " -->";
        return html(`<html>${filler}<head><title>Beyond Limit</title></head></html>`);
      }
      default:
        return html("not found", { status: 404 });
    }
  },
};
