// LinkDock Worker：托管静态网页并提供 HTTP 接口。
//
// 接口约定（均返回 JSON；错误体为 { error, message }，message 为可直接展示的中文）：
//   GET    /api/session        查询登录状态；有效会话时按需续期 Cookie
//   POST   /api/session        { password } 建立会话
//   DELETE /api/session        退出登录
//   GET    /api/links          ?q=搜索词&limit=数量  读取或搜索列表（仅会话），支持 If-None-Match
//   POST   /api/links          { url } 提交链接（会话或上传密钥）
//   DELETE /api/links/:id      删除条目（仅会话）

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
import {
  deleteLink,
  getVersion,
  listLinks,
  savePreviewFailure,
  savePreviewSuccess,
  submitLink,
  toView,
  type LinkRow,
} from "./links";
import { fetchPreview } from "./preview";
import { parseSubmittedUrl } from "./url";

export type { Env } from "./env";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_QUERY_LENGTH = 200;

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
} satisfies ExportedHandler<Env>;

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const extra: Record<string, string> = {};
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
  if (row.preview_status !== "ok") ctx.waitUntil(updatePreview(env, row));

  const label = row.preview_status === "ok" && row.title ? row.title : row.url;
  return json(created ? 201 : 200, {
    created,
    link: toView(row),
    message: created ? `已保存：${label}` : `已保存（已移到顶部）：${label}`,
  });
}

async function updatePreview(env: Env, row: LinkRow): Promise<void> {
  const db = env.DB;
  const timeout = Number(env.PREVIEW_TIMEOUT_MS);
  try {
    const outcome = await fetchPreview(row.url, timeout > 0 ? timeout : undefined);
    if (outcome.ok) {
      await savePreviewSuccess(db, row.id, outcome.preview.title, outcome.preview.iconUrl);
    } else {
      console.log(`预览获取失败（${outcome.reason}）：${row.url}`);
      await savePreviewFailure(db, row.id);
    }
  } catch (err) {
    console.error("保存预览失败", err);
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
