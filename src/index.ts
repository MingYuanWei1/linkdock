// LinkDock Worker：托管静态网页并提供 HTTP 接口。
//
// 接口约定（均返回 JSON；错误体为 { error, message }，message 为可直接展示的中文）：
//   GET    /api/session        查询登录状态；有效会话时按需续期 Cookie
//   POST   /api/session        { password } 建立会话
//   DELETE /api/session        退出登录
//   GET    /api/links          ?q=搜索词&limit=数量  读取或搜索列表（仅会话），支持 If-None-Match
//   POST   /api/links          { url } 提交链接（会话或上传密钥）
//   DELETE /api/links/:id      删除条目（仅会话）
//
// 阅读视图（返回 HTML，供网页端在 sandbox iframe 中显示）：
//   GET    /read/:id           显示已保存链接的文章存档；尚无存档时抓取并存档（仅会话）
//   GET    /read/:id?refresh=1 重新抓取并更新存档；失败时保留并显示原存档
//
// OneNote 导出（可选，见 docs/onenote.md）：
//   GET    /onenote/connect    跳转到 Microsoft 登录授权（仅会话）
//   GET    /onenote/callback   授权完成后保存令牌，跳回 /?onenote=结果
//   GET    /api/onenote        连接状态与导出统计（仅会话）
//   DELETE /api/onenote        断开连接（仅会话）
//   定时任务（wrangler.jsonc triggers）重试未完成的导出

import {
  clearLoginFailures,
  clearSessionCookie,
  clientId,
  configProblem,
  createSessionCookie,
  hasUploadKey,
  isLoginThrottled,
  isSameOriginRequest,
  readSession,
  recordLoginFailure,
  secretEquals,
  SESSION_RENEW_BELOW_MS,
} from "./auth";
import type { Env } from "./env";
import { fetchLinkContent, type LinkContent, type Wanted } from "./content";
import {
  deleteLink,
  getLinkWithArticle,
  getVersion,
  hasArticle,
  listLinks,
  saveArticle,
  savePreviewFailure,
  savePreviewSuccess,
  submitLink,
  toView,
  type LinkRow,
} from "./links";
import {
  disconnect,
  exportArticle,
  exportPending,
  finishConnect,
  oneNoteConfig,
  oneNoteStatus,
  startConnect,
} from "./onenote";
import { renderReaderMessage, renderReaderPage, READER_CSP } from "./reader-page";
import { parseSubmittedUrl } from "./url";

export type { Env } from "./env";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_QUERY_LENGTH = 200;
// 超过此长度的正文不存档（D1 单行上限约 2 MB），仍可实时显示。
const MAX_ARCHIVE_CHARS = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: http: data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const read = /^\/read\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
    if (read) return handleRead(request, env, ctx, read[1], url.searchParams.get("refresh") === "1");
    if (url.pathname === "/onenote/connect" || url.pathname === "/onenote/callback") {
      return withHeaders(await handleOneNoteAuth(request, env, url), { "Cache-Control": "no-store" });
    }
    if (!url.pathname.startsWith("/api/")) return serveAsset(request, env);

    let response: Response;
    try {
      response = await handleApi(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json(err.status, { error: err.code, message: err.message });
      } else {
        console.error("未处理的错误", err);
        const message = request.method === "POST" && url.pathname === "/api/links"
          ? "服务器内部错误，链接未保存"
          : "服务器内部错误";
        response = json(500, { error: "internal", message });
      }
    }
    return withHeaders(response, { "Cache-Control": "no-store" });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    const config = oneNoteConfig(env);
    if (config) ctx.waitUntil(exportPending(env.DB, config, Date.now()));
  },
} satisfies ExportedHandler<Env>;

async function handleRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
  refresh: boolean,
): Promise<Response> {
  // 存档来自数据库，读取很快，不使用浏览器缓存，保证“重新获取”后立即看到新版本。
  const page = (status: number, body: string) =>
    withHeaders(
      new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }),
      {
        "Content-Security-Policy": READER_CSP,
        // 允许被本站页面嵌入（覆盖默认的 DENY）。
        "X-Frame-Options": "SAMEORIGIN",
        "Cache-Control": "no-store",
      },
    );

  try {
    if (request.method !== "GET") {
      return page(405, renderReaderMessage({ heading: "不支持的请求方法" }));
    }
    if (configProblem(env)) {
      return page(503, renderReaderMessage({ heading: "服务尚未完成配置" }));
    }
    const now = Date.now();
    if ((await readSession(request, env, now)) == null) {
      return page(401, renderReaderMessage({ heading: "请先登录", message: "登录已过期，请返回后重新登录。" }));
    }
    const found = await getLinkWithArticle(env.DB, id);
    if (!found) {
      return page(404, renderReaderMessage({ heading: "链接不存在或已被删除" }));
    }
    const { link, article: existing } = found;
    const fallbackTitle = link.preview_status === "ok" ? link.title : null;

    if (existing && !refresh) {
      return page(200, renderReaderPage({
        title: existing.title ?? fallbackTitle,
        byline: existing.byline,
        contentHtml: existing.content_html,
        originalUrl: link.url,
        savedAt: existing.saved_at,
      }));
    }

    const { content, saved } = await fetchAndStore(env, link, {
      preview: link.preview_status !== "ok",
      readable: true,
    }, now);
    if (saved) ctx.waitUntil(exportSaved(env, link.id));
    const outcome = content.readable!;
    if (outcome.ok) {
      return page(200, renderReaderPage({
        ...outcome.readable,
        title: outcome.readable.title ?? fallbackTitle,
        originalUrl: link.url,
        savedAt: saved ? now : null,
      }));
    }
    if (existing) {
      // 重新获取失败：保留并显示原存档。
      return page(200, renderReaderPage({
        title: existing.title ?? fallbackTitle,
        byline: existing.byline,
        contentHtml: existing.content_html,
        originalUrl: link.url,
        savedAt: existing.saved_at,
        notice: `重新获取失败（${outcome.reason}），以下仍是之前保存的版本。`,
      }));
    }
    return page(
      502,
      renderReaderMessage({
        heading: "无法在此显示这篇文章",
        message: `${outcome.reason}。可以返回后重新打开，或打开原网页。`,
        originalUrl: link.url,
      }),
    );
  } catch (err) {
    console.error("阅读视图出错", err);
    return page(500, renderReaderMessage({ heading: "服务器内部错误", message: "可以返回后重新打开。" }));
  }
}

// 连接 OneNote 的两步跳转。结果（包括未登录、未配置）都跳回网页，由网页显示。
async function handleOneNoteAuth(request: Request, env: Env, url: URL): Promise<Response> {
  const back = (result: string) => new Response(null, { status: 302, headers: { Location: `/?onenote=${result}` } });
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const config = oneNoteConfig(env);
  if (configProblem(env) || !config) return back("unavailable");
  const now = Date.now();
  if (url.pathname === "/onenote/connect") {
    if ((await readSession(request, env, now)) == null) return back("login");
    return startConnect(request, config);
  }
  return finishConnect(request, env.DB, config, now);
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const extra: Record<string, string> = {};
  if (new URL(request.url).pathname.endsWith(".shortcut")) {
    // iOS Safari 下载后交给“快捷指令”App 导入。
    extra["Content-Type"] = "application/octet-stream";
    extra["Content-Disposition"] = 'attachment; filename="LinkDock.shortcut"';
  }
  if ((res.headers.get("Content-Type") ?? "").includes("text/html")) {
    extra["Content-Security-Policy"] = PAGE_CSP;
    extra["Cache-Control"] = "no-cache";
  }
  return withHeaders(res, extra);
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const problem = configProblem(env);
  if (problem) {
    console.error("配置错误：" + problem);
    throw new HttpError(503, "not_configured", "服务尚未完成配置，请检查部署密钥设置");
  }

  const now = Date.now();
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/session") {
    if (method === "GET") return getSession(request, env, now);
    if (method === "POST") return login(request, env, now);
    if (method === "DELETE") {
      requireSameOrigin(request);
      return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie() } });
    }
    throw methodNotAllowed();
  }

  if (pathname === "/api/links") {
    if (method === "GET") {
      await requireSession(request, env, now);
      return getLinks(request, env, url);
    }
    if (method === "POST") return postLink(request, env, ctx, now);
    throw methodNotAllowed();
  }

  if (pathname === "/api/onenote") {
    await requireSession(request, env, now);
    const config = oneNoteConfig(env);
    if (method === "GET") return json(200, await oneNoteStatus(env.DB, config));
    if (method === "DELETE") {
      requireSameOrigin(request);
      await disconnect(env.DB);
      return new Response(null, { status: 204 });
    }
    throw methodNotAllowed();
  }

  const item = /^\/api\/links\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
  if (item) {
    if (method !== "DELETE") throw methodNotAllowed();
    await requireSession(request, env, now);
    requireSameOrigin(request);
    const deleted = await deleteLink(env.DB, item[1]);
    if (!deleted) throw new HttpError(404, "not_found", "链接不存在或已被删除");
    return new Response(null, { status: 204 });
  }

  throw new HttpError(404, "not_found", "接口不存在");
}

async function getSession(request: Request, env: Env, now: number): Promise<Response> {
  const expires = await readSession(request, env, now);
  if (expires == null) throw new HttpError(401, "unauthenticated", "请先登录");
  const headers: Record<string, string> = {};
  if (expires - now < SESSION_RENEW_BELOW_MS) {
    headers["Set-Cookie"] = await createSessionCookie(env, now);
  }
  return json(200, { authenticated: true }, headers);
}

async function login(request: Request, env: Env, now: number): Promise<Response> {
  requireSameOrigin(request);
  const client = clientId(request);
  if (await isLoginThrottled(env.DB, client, now)) {
    throw new HttpError(429, "too_many_attempts", "尝试次数过多，请 15 分钟后再试");
  }
  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) throw new HttpError(400, "invalid_input", "请输入密码");

  if (!(await secretEquals(password, env.APP_PASSWORD))) {
    await recordLoginFailure(env.DB, client, now);
    throw new HttpError(401, "wrong_password", "密码错误");
  }
  await clearLoginFailures(env.DB, client);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": await createSessionCookie(env, now) },
  });
}

async function getLinks(request: Request, env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIST_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : DEFAULT_LIST_LIMIT;

  // 先读版本再读列表：之后的任何变化都会让版本号超过本次返回值，下次轮询必然重新获取。
  const version = await getVersion(env.DB);
  const etag = `"${version}-${limit}-${encodeURIComponent(q)}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  const { rows, hasMore } = await listLinks(env.DB, { query: q, limit });
  return json(200, { version, links: rows.map(toView), hasMore }, { ETag: etag });
}

async function postLink(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: number,
): Promise<Response> {
  if (request.headers.has("Authorization")) {
    if (!(await hasUploadKey(request, env))) {
      throw new HttpError(401, "invalid_upload_key", "上传密钥无效，请检查快捷指令配置");
    }
  } else {
    await requireSession(request, env, now);
    requireSameOrigin(request);
  }

  const body = await readJson(request);
  const parsed = parseSubmittedUrl(body.url);
  if (!parsed.ok) throw new HttpError(400, "invalid_url", parsed.reason);

  const { row, created } = await submitLink(env.DB, parsed.url, parsed.dedupKey, now);
  // 在后台一次抓取中补全预览并存档正文；已有的有效预览和存档不重复抓取。
  const want: Wanted = {
    preview: row.preview_status !== "ok",
    readable: !(await hasArticle(env.DB, row.id)),
  };
  if (want.preview || want.readable) {
    ctx.waitUntil(
      fetchAndStore(env, row, want, now)
        .then(({ saved }) => (saved ? exportSaved(env, row.id) : undefined))
        .catch((err) => console.error("后台抓取失败", err)),
    );
  }

  const label = row.preview_status === "ok" && row.title ? row.title : row.url;
  return json(created ? 201 : 200, {
    created,
    link: toView(row),
    message: created ? `已保存：${label}` : `已保存（已移到顶部）：${label}`,
  });
}

// 抓取链接内容并保存：预览结果写入条目，正文写入存档。
// 两者都只更新仍然存在的条目，失败的预览不会覆盖有效预览。
async function fetchAndStore(
  env: Env,
  row: LinkRow,
  want: Wanted,
  now: number,
): Promise<{ content: LinkContent; saved: boolean }> {
  const timeout = Number(env.FETCH_TIMEOUT_MS);
  const content = await fetchLinkContent(row.url, want, timeout > 0 ? timeout : undefined);

  if (content.preview) {
    if (content.preview.ok) {
      await savePreviewSuccess(env.DB, row.id, content.preview.preview.title, content.preview.preview.iconUrl);
    } else {
      console.log(`预览获取失败（${content.preview.reason}）：${row.url}`);
      await savePreviewFailure(env.DB, row.id);
    }
  }

  let saved = false;
  const readable = content.readable;
  if (readable?.ok && readable.readable.contentHtml.length <= MAX_ARCHIVE_CHARS) {
    saved = await saveArticle(env.DB, {
      link_id: row.id,
      title: readable.readable.title,
      byline: readable.readable.byline,
      content_html: readable.readable.contentHtml,
      source_url: readable.readable.finalUrl,
    }, now);
  } else if (readable && !readable.ok) {
    console.log(`正文存档失败（${readable.reason}）：${row.url}`);
  }
  return { content, saved };
}

// 刚保存的存档导出到 OneNote；未配置或未连接时不做任何事。在后台运行，不抛出错误。
async function exportSaved(env: Env, linkId: string): Promise<void> {
  const config = oneNoteConfig(env);
  if (!config) return;
  try {
    await exportArticle(env.DB, config, linkId, Date.now());
  } catch (err) {
    console.error("导出到 OneNote 失败", err);
  }
}

async function requireSession(request: Request, env: Env, now: number): Promise<void> {
  if ((await readSession(request, env, now)) != null) return;
  // 上传密钥只能提交链接；携带有效上传密钥访问其他操作时明确告知权限不足。
  if (await hasUploadKey(request, env)) {
    throw new HttpError(403, "forbidden", "上传密钥只能用于提交链接");
  }
  throw new HttpError(401, "unauthenticated", "请先登录");
}

function requireSameOrigin(request: Request): void {
  if (!isSameOriginRequest(request)) {
    throw new HttpError(403, "cross_origin", "请求来源无效");
  }
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, "method_not_allowed", "不支持的请求方法");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, "unsupported_media_type", "请求内容必须是 JSON");
  }
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "请求内容过大");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "请求内容过大");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "请求内容不是有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_json", "请求内容不是有效的 JSON");
  }
  return value as Record<string, unknown>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}
