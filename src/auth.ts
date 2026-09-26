// 鉴权：网页密码建立会话 Cookie；上传密钥只用于提交链接。
//
// 会话为无状态签名 Cookie：值为 "<过期时间>.<签名>"，签名密钥由 SESSION_SECRET 与
// APP_PASSWORD 共同派生，因此更换其中任意一个都会让所有已登录设备失效。

import type { Env } from "./env";

export const SESSION_COOKIE = "__Host-linkdock_session";
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// 剩余有效期短于此值时，打开页面会自动续期，常用设备无需重新登录。
export const SESSION_RENEW_BELOW_MS = 90 * 24 * 60 * 60 * 1000;

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;

const MIN_PASSWORD_LENGTH = 8;
const MIN_KEY_LENGTH = 24;

const encoder = new TextEncoder();

// 缺少或过弱的密钥配置时拒绝服务（失败即关闭），而不是退化为无保护状态。
export function configProblem(env: Env): string | null {
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return `APP_PASSWORD 未设置或少于 ${MIN_PASSWORD_LENGTH} 个字符`;
  }
  if (!env.UPLOAD_KEY || env.UPLOAD_KEY.length < MIN_KEY_LENGTH) {
    return `UPLOAD_KEY 未设置或少于 ${MIN_KEY_LENGTH} 个字符`;
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < MIN_KEY_LENGTH) {
    return `SESSION_SECRET 未设置或少于 ${MIN_KEY_LENGTH} 个字符`;
  }
  if (env.UPLOAD_KEY === env.APP_PASSWORD) {
    return "UPLOAD_KEY 不能与 APP_PASSWORD 相同";
  }
  return null;
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

// 先各自取摘要再比较，长度固定，比较时间与输入内容无关。
export async function secretEquals(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`${env.SESSION_SECRET}\0${env.APP_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function createSessionCookie(env: Env, now: number): Promise<string> {
  const expires = now + SESSION_TTL_MS;
  const payload = `v1.${expires}`;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(payload));
  const value = `${payload}.${base64url(sig)}`;
  return serializeCookie(value, Math.floor(SESSION_TTL_MS / 1000));
}

export function clearSessionCookie(): string {
  return serializeCookie("", 0);
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

// 返回会话过期时间；无会话或签名无效时返回 null。
export async function readSession(request: Request, env: Env, now: number): Promise<number | null> {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return null;
  const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) return null;
  const expires = Number(m[1]);
  if (!Number.isSafeInteger(expires) || expires <= now) return null;
  const sig = fromBase64url(m[2]);
  if (!sig) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(env),
    sig,
    encoder.encode(`v1.${m[1]}`),
  );
  return valid ? expires : null;
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// 上传密钥只接受 Authorization 请求头，不接受 URL 查询参数。
export async function hasUploadKey(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return secretEquals(m[1], env.UPLOAD_KEY);
}

// 使用 Cookie 的写操作必须来自同源页面，防止跨站请求伪造。
// SameSite=Strict 已阻止跨站请求携带 Cookie，这里再做一次独立校验。
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return true;
}

export function clientId(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

export async function isLoginThrottled(db: D1Database, client: string, now: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT count, window_start FROM login_failures WHERE client = ?1")
    .bind(client)
    .first<{ count: number; window_start: number }>();
  return !!row && now - row.window_start < LOGIN_WINDOW_MS && row.count >= LOGIN_MAX_FAILURES;
}

export async function recordLoginFailure(db: D1Database, client: string, now: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO login_failures (client, count, window_start) VALUES (?1, 1, ?2)
         ON CONFLICT (client) DO UPDATE SET
           count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
      )
      .bind(client, now, LOGIN_WINDOW_MS),
    db.prepare("DELETE FROM login_failures WHERE window_start < ?1").bind(now - LOGIN_WINDOW_MS),
  ]);
}

export async function clearLoginFailures(db: D1Database, client: string): Promise<void> {
  await db.prepare("DELETE FROM login_failures WHERE client = ?1").bind(client).run();
}
