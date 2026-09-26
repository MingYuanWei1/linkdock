// 可控的“外部网站”：测试中 LinkDock Worker 的所有出站请求都由这里应答。
// 访问 https://fixture.control/requests 可查看收到的请求（用于断言请求头与访问目标）。

const requests = [];

// 模拟 Microsoft 登录与 OneNote 接口；测试通过 https://fixture.control/microsoft?… 调整行为。
const MICROSOFT_DEFAULTS = { failPages: 0, rejectRefresh: false, expiresIn: 3600 };
const microsoft = { ...MICROSOFT_DEFAULTS, issued: 0, pages: 0 };

function microsoftReset() {
  Object.assign(microsoft, MICROSOFT_DEFAULTS, { issued: 0, pages: 0 });
}

function tokenResponse(form) {
  if (form.get("client_id") !== "test-client-id" || form.get("client_secret") !== "test-client-secret") {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  const grant = form.get("grant_type");
  const valid = grant === "authorization_code"
    ? form.get("code") === "good-code" && !!form.get("code_verifier")
    // 刷新令牌会轮换：只有最近签发的一个有效。
    : grant === "refresh_token" && !microsoft.rejectRefresh && form.get("refresh_token") === `refresh-${microsoft.issued}`;
  if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });
  microsoft.issued += 1;
  return Response.json({
    token_type: "Bearer",
    scope: form.get("scope"),
    expires_in: microsoft.expiresIn,
    access_token: `access-${microsoft.issued}`,
    refresh_token: `refresh-${microsoft.issued}`,
  });
}

function createPageResponse(request) {
  if (!/^Bearer access-\d+$/.test(request.headers.get("Authorization") ?? "")) {
    return Response.json({ error: { code: "40001", message: "Unauthorized" } }, { status: 401 });
  }
  if (microsoft.failPages > 0) {
    microsoft.failPages -= 1;
    return Response.json({ error: { code: "20001", message: "Service unavailable" } }, { status: 503 });
  }
  microsoft.pages += 1;
  return Response.json(
    { id: `page-${microsoft.pages}`, links: { oneNoteWebUrl: { href: `https://onenote.example/page-${microsoft.pages}` } } },
    { status: 201 },
  );
}

const WECHAT_ARTICLE = (title) => `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta property="og:title" content="${title}" />
<meta property="og:type" content="article" />
<link rel="shortcut icon" type="image/x-icon" href="//res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico" />
<title></title>
</head><body>
<div id="page-content">
  <h1 class="rich_media_title" id="activity-name">${title}</h1>
  <a href="javascript:void(0);" id="js_name">示例公众号</a>
  <div class="rich_media_content js_underline_content" id="js_content" style="visibility: hidden; opacity: 0; ">
    <section style="margin: 0px 8px; color: rgb(62, 62, 62); visibility: visible;">
      <p style="text-align: center;">第一段正文，介绍这篇文章的主要内容，包含足够多的文字用于阅读视图测试。</p>
      <p><img class="rich_pages wxw-img" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/640?wx_fmt=jpeg" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" style="width: 100%; visibility: visible !important;" onerror="window.__xss=1" alt="配图"></p>
      <p>第二段<a href="https://example.org/ref?a=1&amp;b=2">参考链接</a>和<a href="javascript:alert(1)">恶意链接</a>。</p>
      <ul><li>列表一<li>列表二</ul>
      <mp-common-profile class="js_uneditable" data-nickname="示例"><p>自定义元素中的文字</p></mp-common-profile>
      <iframe class="video_iframe" data-src="https://v.qq.com/x"></iframe>
      <svg><script>window.__xss=2</script><text>svg 文本</text></svg>
      <form action="https://evil.example/"><input name="q"><button>提交</button></form>
      <p style="background-image: url(https://tracker.example/x.png); font-weight: bold; position: fixed;">第三段加粗</p>
    </section>
  </div>
  <div id="js_pc_qr_code">微信扫一扫关注该公众号</div>
</div>
<script nonce="1">var msg_title = '${title}';</script>
</body></html>`;

const WECHAT_ERROR_PAGE = `<!DOCTYPE html><html><head><title>未知错误</title></head>
<body><div class="panel"><div class="mesg-block"><p>未知错误，请稍后再试</p></div></div></body></html>`;

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
        microsoftReset();
        return new Response("ok");
      }
      if (url.pathname === "/microsoft") {
        for (const [key, value] of url.searchParams) {
          microsoft[key] = typeof MICROSOFT_DEFAULTS[key] === "boolean" ? value === "1" : Number(value);
        }
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    }

    const isMicrosoft = url.hostname === "login.microsoftonline.com" || url.hostname === "graph.microsoft.com";
    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(isMicrosoft && request.method === "POST" ? { body: await request.clone().text() } : {}),
    });

    if (url.hostname === "login.microsoftonline.com" && url.pathname.endsWith("/oauth2/v2.0/token")) {
      return tokenResponse(new URLSearchParams(await request.text()));
    }
    if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/me/onenote/pages" && request.method === "POST") {
      return createPageResponse(request);
    }

    if (url.hostname === "mp.weixin.qq.com") {
      if (url.pathname === "/s/ErrorPageSample0001") return html(WECHAT_ERROR_PAGE);
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
      case "/reader-article":
        return html(`<!doctype html><html><head><title>普通文章</title></head><body>
          <nav><ul><li><a href="/">首页</a><li><a href="/about">关于</a></ul></nav>
          <article>
            <h1>普通文章标题</h1>
            <p>这是一篇普通网站的文章正文，包含足够长的文字，用来确认阅读视图提取的是 article 元素中的内容。</p>
            <p><img src="/images/photo.jpg" alt="照片"> <a href="/related">相关文章</a></p>
            <xmp><script>window.__xss=3</script></xmp>
            <noscript><img src="x" onerror="window.__xss=4"></noscript>
            <p onclick="window.__xss=5">点击事件被移除</p>
          </article>
          <aside>侧边栏广告</aside>
          <footer>页脚版权信息</footer>
        </body></html>`);
      case "/reader-body":
        return html(`<html><head><title>没有 article 的页面</title></head><body>
          <div class="post"><p>这个页面没有 article 或 main 元素，所以阅读视图会使用整个 body 中的正文内容来显示。</p></div>
        </body></html>`);
      case "/reader-long":
        // 正文超过存档上限（1 MiB 字符）。
        return html(`<html><head><title>超长文章</title></head><body><article><p>${"长".repeat(1_100_000)}</p></article></body></html>`);
      case "/reader-empty":
        return html(`<html><head><title>脚本渲染的页面</title></head><body><div id="app"></div>
          <script src="/bundle.js"></script></body></html>`);
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
