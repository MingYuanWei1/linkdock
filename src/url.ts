// 链接校验与去重身份。
//
// 去重策略保守：只合并能确认指向同一内容的链接。
// - 通用链接：协议、主机名大小写与默认端口由 URL 解析统一；去掉空片段与 utm_* 跟踪参数；
//   其余查询参数和片段原样保留，不排序、不删除尾部斜杠。
// - 微信公众号文章（mp.weixin.qq.com）：只在能识别稳定文章标识时归并，
//   忽略 http/https、分享来源（scene、from 等）与校验参数（chksm 等）的差异。
//   短链 /s/<id> 与长链 /s?__biz=… 之间无法离线确认是否同一篇，不相互归并。

export const MAX_URL_LENGTH = 4096;

export type ParseResult =
  | { ok: true; url: string; dedupKey: string }
  | { ok: false; reason: string };

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
]);

export function parseSubmittedUrl(input: unknown): ParseResult {
  if (typeof input !== "string") return { ok: false, reason: "请提供链接" };
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "请提供链接" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "链接过长" };
  if (/\s/.test(raw)) return { ok: false, reason: "链接中不能包含空格或换行" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "不是有效的网页链接" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "只支持 http 或 https 网页链接" };
  }
  if (!url.hostname) return { ok: false, reason: "不是有效的网页链接" };
  if (url.username || url.password) {
    return { ok: false, reason: "链接中不能包含用户名或密码" };
  }

  return { ok: true, url: url.href, dedupKey: dedupKeyFor(url) };
}

export function dedupKeyFor(url: URL): string {
  return wechatArticleKey(url) ?? genericKey(url);
}

function genericKey(url: URL): string {
  const u = new URL(url.href);
  const kept = [...u.searchParams].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  if (kept.length !== [...u.searchParams].length) {
    u.search = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
  }
  // 单独的 "#" 在解析后是空片段；赋值空字符串会把它去掉，非空片段保持不变。
  if (!u.hash) u.hash = "";
  return "url:" + u.href;
}

const WECHAT_HOST = "mp.weixin.qq.com";

function wechatArticleKey(url: URL): string | null {
  if (url.hostname !== WECHAT_HOST) return null;

  // 短链形式：https://mp.weixin.qq.com/s/<文章标识>
  const short = /^\/s\/([A-Za-z0-9_-]{8,})\/?$/.exec(url.pathname);
  if (short) return `wechat:s:${short[1]}`;

  // 长链形式：/s?__biz=…&mid=…&idx=…&sn=…（与旧路径 /s 等价的 /s/ 同样处理）
  if (url.pathname === "/s" || url.pathname === "/s/") {
    const params = rawQueryParams(url.search);
    const biz = params.get("__biz");
    const mid = params.get("mid");
    const idx = params.get("idx");
    const sn = params.get("sn");
    if (
      biz && /^[A-Za-z0-9+/=]+$/.test(biz) &&
      mid && /^\d+$/.test(mid) &&
      idx && /^\d+$/.test(idx) &&
      sn && /^[0-9a-fA-F]+$/.test(sn)
    ) {
      return `wechat:biz:${biz}:${mid}:${idx}:${sn.toLowerCase()}`;
    }
  }
  return null;
}

// 与 URLSearchParams 不同，不把 "+" 解码为空格（__biz 是 base64，可能包含 "+"）。
function rawQueryParams(search: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = safeDecode(eq === -1 ? part : part.slice(0, eq));
    const value = safeDecode(eq === -1 ? "" : part.slice(eq + 1));
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 预览抓取只访问公网主机，避免服务端请求伪造访问内部地址。
export function isPublicHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/\.(local|internal|lan|home|intranet|corp)$/.test(host)) return false;
  if (host.startsWith("[")) return isPublicIPv6(host.slice(1, -1));
  if (/^[0-9.]+$/.test(host)) return isPublicIPv4(host);
  // 其余形式（如十六进制或八进制 IP）已由 URL 解析规范化为点分十进制；
  // 单标签主机名（无点）不是公网域名。
  return host.includes(".");
}

function isPublicIPv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // 运营商级 NAT
  if (a === 169 && b === 254) return false; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false; // 组播与保留地址
  return true;
}

function isPublicIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return false;
  if (h.startsWith("fc") || h.startsWith("fd")) return false; // 唯一本地地址
  if (/^fe[89ab]/.test(h)) return false; // 链路本地
  if (h.startsWith("ff")) return false; // 组播
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return isPublicIPv4(mapped[1]);
  if (h.startsWith("::ffff:")) return false;
  return true;
}
