// OneNote 导出：把存档的文章正文创建为本人 Microsoft 账户中的 OneNote 页面。
//
// OneNote 接口自 2025-03-31 起不再接受应用身份（app-only）令牌，因此使用委托授权：
// 本人在网页点“连接 OneNote”登录 Microsoft 账户，Worker 保存刷新令牌，之后在后台
// 换取访问令牌创建页面。只申请 Notes.Create：可以创建页面与分区，不能读取或删除已有笔记。
//
// 导出范围：首次连接之后存档（包括“重新获取”或首次打开时存档）的文章，每个链接最多导出一次。
// 存档后立即尝试导出；失败的由定时任务重试，最多 MAX_ATTEMPTS 次。

import { base64url, getCookie, secretEquals } from "./auth";
import type { Env } from "./env";
import { escapeText } from "./reader";
import { escapeAttr } from "./reader-page";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";
const SCOPE = "offline_access https://graph.microsoft.com/Notes.Create";
const STATE_COOKIE = "__Host-linkdock_onenote";
const STATE_TTL_SECONDS = 10 * 60;
const DEFAULT_TENANT = "consumers";
const DEFAULT_SECTION = "LinkDock";
export const MAX_ATTEMPTS = 5;
// 超过此时间仍为 sending 的导出视为中断（例如 Worker 被终止），允许重试。
const STALE_SENDING_MS = 10 * 60 * 1000;
// 访问令牌剩余有效期短于此值时提前刷新。
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const BATCH_SIZE = 10;
// 刷新令牌长期（约 90 天）不用会失效；超过此时间没有换取过访问令牌时，定时任务主动刷新一次。
const KEEPALIVE_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

export interface OneNoteConfig {
  clientId: string;
  clientSecret: string;
  tenant: string;
  section: string;
}

// 未配置应用注册时 OneNote 导出整体关闭，不影响其他功能。
export function oneNoteConfig(env: Env): OneNoteConfig | null {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return null;
  const tenant = env.MS_TENANT || DEFAULT_TENANT;
  if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) {
    console.error("配置错误：MS_TENANT 格式无效");
    return null;
  }
  return {
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    tenant,
    section: env.ONENOTE_SECTION || DEFAULT_SECTION,
  };
}

// 刷新令牌被拒绝（失效、被撤销、应用密钥过期等），需要本人处理后重新连接。
export class OneNoteAuthError extends Error {}

// ---------- 连接（OAuth 授权码流程 + PKCE） ----------

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/onenote/callback`;
}

// 回调来自 login.microsoftonline.com 的跨站跳转，SameSite=Strict 的会话 Cookie 不会随之发送；
// 因此由这个只在已登录时设置的 Lax Cookie 证明流程由本人发起，并保存 PKCE 校验值。
function stateCookie(value: string, maxAgeSeconds: number): string {
  return `${STATE_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// 调用方负责确认已登录。
export async function startConnect(request: Request, config: OneNoteConfig): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));
  const authorize = new URL(`${LOGIN}/${config.tenant}/oauth2/v2.0/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri(request),
    response_mode: "query",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Set-Cookie": stateCookie(`${state}.${verifier}`, STATE_TTL_SECONDS),
    },
  });
}

// 完成授权后回到网页，由网页根据 onenote 参数显示结果。
export async function finishConnect(
  request: Request,
  db: D1Database,
  config: OneNoteConfig,
  now: number,
): Promise<Response> {
  const done = (result: "connected" | "denied" | "failed") =>
    new Response(null, {
      status: 302,
      headers: { Location: `/?onenote=${result}`, "Set-Cookie": stateCookie("", 0) },
    });

  const params = new URL(request.url).searchParams;
  const [state, verifier] = (getCookie(request, STATE_COOKIE) ?? "").split(".");
  const given = params.get("state");
  if (!state || !verifier || !given || !(await secretEquals(given, state))) return done("failed");

  const error = params.get("error");
  if (error) {
    console.log(`OneNote 授权未完成（${error}）：${params.get("error_description") ?? ""}`);
    return done(error === "access_denied" ? "denied" : "failed");
  }
  const code = params.get("code");
  if (!code) return done("failed");

  try {
    const tokens = await requestToken(config, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(request),
      code_verifier: verifier,
    }, now);
    if (!tokens.refreshToken) throw new Error("授权结果没有刷新令牌（缺少 offline_access）");
    await db
      .prepare(
        `INSERT INTO onenote_account (id, refresh_token, access_token, access_expires, connected_at, last_error)
         VALUES (1, ?1, ?2, ?3, ?4, NULL)
         ON CONFLICT (id) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           access_expires = excluded.access_expires,
           last_error = NULL`,
      )
      .bind(tokens.refreshToken, tokens.accessToken, tokens.expiresAt, now)
      .run();
  } catch (err) {
    console.error("连接 OneNote 失败", err);
    return done("failed");
  }
  return done("connected");
}

// 只删除本地保存的令牌；已导出的页面保留在 OneNote 中。
export async function disconnect(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM onenote_account").run();
}

export interface OneNoteStatus {
  available: boolean;
  connected: boolean;
  error: string | null;
  exported: number;
  failed: number;
}

export async function oneNoteStatus(db: D1Database, config: OneNoteConfig | null): Promise<OneNoteStatus> {
  if (!config) return { available: false, connected: false, error: null, exported: 0, failed: 0 };
  const [account, counts] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT last_error FROM onenote_account WHERE id = 1"),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'done'), 0) AS exported,
           COALESCE(SUM(status = 'failed' AND attempts >= ?1), 0) AS failed
         FROM onenote_exports`,
      )
      .bind(MAX_ATTEMPTS),
  ]);
  const accountRow = account.results[0] as { last_error: string | null } | undefined;
  const countRow = counts.results[0] as { exported: number; failed: number };
  return {
    available: true,
    connected: accountRow != null,
    error: accountRow?.last_error ?? null,
    exported: countRow.exported,
    failed: countRow.failed,
  };
}

// ---------- 令牌 ----------

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

async function requestToken(
  config: OneNoteConfig,
  params: Record<string, string>,
  now: number,
): Promise<Tokens> {
  const res = await fetch(`${LOGIN}/${config.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: SCOPE,
      ...params,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (res.status === 400 || res.status === 401) {
    throw new OneNoteAuthError(`Microsoft 拒绝了授权（${body.error ?? res.status}），请重新连接 OneNote`);
  }
  if (!res.ok || !body.access_token) {
    throw new Error(`Microsoft 登录服务暂时不可用（${res.status}）`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
  };
}

interface AccountRow {
  refresh_token: string;
  access_token: string | null;
  access_expires: number | null;
}

async function accessToken(db: D1Database, config: OneNoteConfig, now: number): Promise<string> {
  const account = await db
    .prepare("SELECT refresh_token, access_token, access_expires FROM onenote_account WHERE id = 1")
    .first<AccountRow>();
  if (!account) throw new OneNoteAuthError("尚未连接 OneNote");
  if (account.access_token && (account.access_expires ?? 0) - now > TOKEN_MARGIN_MS) {
    return account.access_token;
  }

  let tokens: Tokens;
  try {
    tokens = await requestToken(config, {
      grant_type: "refresh_token",
      refresh_token: account.refresh_token,
    }, now);
  } catch (err) {
    if (err instanceof OneNoteAuthError) {
      await db.prepare("UPDATE onenote_account SET last_error = ?1 WHERE id = 1").bind(err.message).run();
    }
    throw err;
  }
  // Microsoft 会轮换刷新令牌，必须保存新的；期间已断开连接则不写入。
  await db
    .prepare(
      `UPDATE onenote_account SET refresh_token = ?1, access_token = ?2, access_expires = ?3, last_error = NULL
       WHERE id = 1`,
    )
    .bind(tokens.refreshToken ?? account.refresh_token, tokens.accessToken, tokens.expiresAt)
    .run();
  return tokens.accessToken;
}

// ---------- 导出 ----------

// 原子地领取一个链接的导出任务：只有连接之后存档、尚未导出、未在导出中且未超过重试次数的才会领取。
// 立即导出与定时任务同时运行时，只有一方能领取，避免创建重复页面。
async function claim(db: D1Database, linkId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO onenote_exports (link_id, status, attempts, updated_at)
       SELECT ?1, 'sending', 1, ?2
       WHERE EXISTS (
         SELECT 1 FROM articles a, onenote_account acc
         WHERE a.link_id = ?1 AND acc.id = 1 AND acc.last_error IS NULL AND a.saved_at >= acc.connected_at
       )
       ON CONFLICT (link_id) DO UPDATE SET
         status = 'sending',
         attempts = onenote_exports.attempts + 1,
         updated_at = excluded.updated_at
       WHERE onenote_exports.attempts < ?3 AND (
         onenote_exports.status = 'failed' OR
         (onenote_exports.status = 'sending' AND onenote_exports.updated_at < ?2 - ?4)
       )`,
    )
    .bind(linkId, now, MAX_ATTEMPTS, STALE_SENDING_MS)
    .run();
  return result.meta.changes > 0;
}

interface ExportSource {
  url: string;
  first_saved_at: number;
  link_title: string | null;
  title: string | null;
  byline: string | null;
  content_html: string;
}

// 导出一篇文章（不符合条件时什么也不做）。授权失败时抛出 OneNoteAuthError，其他失败记录后返回。
export async function exportArticle(
  db: D1Database,
  config: OneNoteConfig,
  linkId: string,
  now: number,
): Promise<void> {
  if (!(await claim(db, linkId, now))) return;
  let pageUrl: string | null;
  try {
    const source = await db
      .prepare(
        `SELECT l.url, l.first_saved_at, CASE WHEN l.preview_status = 'ok' THEN l.title END AS link_title,
                a.title, a.byline, a.content_html
         FROM articles a JOIN links l ON l.id = a.link_id WHERE a.link_id = ?1`,
      )
      .bind(linkId)
      .first<ExportSource>();
    if (!source) {
      // 领取后链接被删除。
      await db.prepare("DELETE FROM onenote_exports WHERE link_id = ?1").bind(linkId).run();
      return;
    }
    pageUrl = await createPage(db, config, await accessToken(db, config, now), source);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = name === "TimeoutError" || name === "AbortError"
      ? "请求超时"
      : err instanceof Error ? err.message : "导出失败";
    console.log(`导出到 OneNote 失败（${message}）：${linkId}`);
    // 授权问题不计入重试次数：重新连接后继续导出。
    const refund = err instanceof OneNoteAuthError ? 1 : 0;
    await db
      .prepare(
        `UPDATE onenote_exports SET status = 'failed', attempts = attempts - ?2, last_error = ?3, updated_at = ?4
         WHERE link_id = ?1`,
      )
      .bind(linkId, refund, message, now)
      .run();
    if (err instanceof OneNoteAuthError) throw err;
    return;
  }
  await db
    .prepare(
      `UPDATE onenote_exports SET status = 'done', page_url = ?2, last_error = NULL, updated_at = ?3
       WHERE link_id = ?1`,
    )
    .bind(linkId, pageUrl, now)
    .run();
}

// 定时任务：导出尚未导出或失败待重试的文章，按存档时间先后，每次最多 BATCH_SIZE 篇；
// 长时间没有导出时刷新令牌以保持连接。
export async function exportPending(db: D1Database, config: OneNoteConfig, now: number): Promise<void> {
  const idle = await db
    .prepare(
      `SELECT 1 AS idle FROM onenote_account
       WHERE id = 1 AND last_error IS NULL AND COALESCE(access_expires, 0) < ?1`,
    )
    .bind(now - KEEPALIVE_MS)
    .first();
  if (idle) {
    try {
      await accessToken(db, config, now);
    } catch (err) {
      if (err instanceof OneNoteAuthError) return;
      throw err;
    }
  }

  const { results } = await db
    .prepare(
      `SELECT a.link_id FROM articles a
       JOIN onenote_account acc ON acc.id = 1 AND acc.last_error IS NULL
       LEFT JOIN onenote_exports e ON e.link_id = a.link_id
       WHERE a.saved_at >= acc.connected_at
         AND (e.link_id IS NULL OR (e.status <> 'done' AND e.attempts < ?1))
       ORDER BY a.saved_at LIMIT ?2`,
    )
    .bind(MAX_ATTEMPTS, BATCH_SIZE)
    .all<{ link_id: string }>();
  for (const { link_id } of results) {
    try {
      await exportArticle(db, config, link_id, now);
    } catch (err) {
      if (err instanceof OneNoteAuthError) return; // 需要重新连接，其余文章留到之后
      throw err;
    }
  }
}

async function createPage(
  db: D1Database,
  config: OneNoteConfig,
  token: string,
  source: ExportSource,
): Promise<string | null> {
  // sectionName：默认笔记本中的顶级分区，不存在时自动创建（只需 Notes.Create 权限）。
  const res = await fetch(`${GRAPH}/me/onenote/pages?sectionName=${encodeURIComponent(config.section)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/html; charset=utf-8",
      Accept: "application/json",
    },
    body: pageHtml(source),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) {
    // 缓存的访问令牌已失效：清除后下次重新换取。
    await db.prepare("UPDATE onenote_account SET access_token = NULL WHERE id = 1").run();
  }
  if (res.status !== 201) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const reason = detail?.error?.message ? `：${detail.error.message.slice(0, 200)}` : "";
    throw new Error(`创建 OneNote 页面失败（${res.status}）${reason}`);
  }
  const page = (await res.json().catch(() => null)) as { links?: { oneNoteWebUrl?: { href?: string } } } | null;
  return page?.links?.oneNoteWebUrl?.href ?? null;
}

// OneNote 输入 HTML：标题与创建时间放在 head 中；正文使用已按白名单清理的存档。
// 图片仍是原网站地址，由 OneNote 在创建页面时下载保存。
export function pageHtml(source: ExportSource): string {
  const title = source.title ?? source.link_title ?? source.url;
  const byline = source.byline ? `<p>${escapeText(source.byline)}</p>\n` : "";
  return `<!DOCTYPE html>
<html>
<head>
<title>${escapeText(title)}</title>
<meta name="created" content="${new Date(source.first_saved_at).toISOString()}" />
</head>
<body>
<p>原文：<a href="${escapeAttr(source.url)}">${escapeText(source.url)}</a></p>
${byline}${source.content_html}
</body>
</html>`;
}
