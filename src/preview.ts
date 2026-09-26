// 链接预览：获取网页标题与网站图标。
//
// 安全限制：总时限、响应大小上限、每一跳重定向都校验目标必须是公网 http(s) 地址；
// 请求不携带任何 Cookie 或凭证。标题只作为纯文本保存和显示。

import { isPublicHttpUrl } from "./url";

export const PREVIEW_TIMEOUT_MS = 8_000;
export const MAX_HTML_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_TITLE_LENGTH = 300;
const MAX_ICON_URL_LENGTH = 2048;

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export interface Preview {
  title: string;
  iconUrl: string | null;
}

export type PreviewOutcome =
  | { ok: true; preview: Preview }
  | { ok: false; reason: string };

export async function fetchPreview(
  target: string,
  timeoutMs: number = PREVIEW_TIMEOUT_MS,
): Promise<PreviewOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const fetched = await fetchPage(target, signal, { maxBytes: MAX_HTML_BYTES, stopAt: /<\/head\s*>/i });
    if (!fetched.ok) return fetched;
    const meta = await extractMetadata(fetched.html);
    const finalUrl = new URL(fetched.finalUrl);

    const title = pickTitle(meta, finalUrl);
    if (!title) return { ok: false, reason: "页面没有可用标题" };
    return { ok: true, preview: { title, iconUrl: pickIcon(meta, finalUrl) } };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "请求超时" };
    return { ok: false, reason: "请求失败" };
  }
}

export type FetchPageResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; reason: string };

export interface FetchPageOptions {
  maxBytes: number;
  // 读到匹配内容后提前停止（例如 </head>）；为空时读到结束或大小上限。
  stopAt: RegExp | null;
}

// 安全地获取网页 HTML：只访问公网地址、手动校验每一跳重定向、限制大小、不携带凭证。
export async function fetchPage(
  target: string,
  signal: AbortSignal,
  { maxBytes, stopAt }: FetchPageOptions,
): Promise<FetchPageResult> {
  let current = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPublicHttpUrl(current)) return { ok: false, reason: "目标地址不是公网网页" };

    const res = await fetch(current.href, {
      method: "GET",
      headers: REQUEST_HEADERS,
      redirect: "manual",
      signal,
    });

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get("Location");
      if (!location) return { ok: false, reason: "重定向缺少目标地址" };
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, reason: "重定向目标无效" };
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, reason: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await res.body?.cancel();
      return { ok: false, reason: "不是网页内容" };
    }

    const declaredLength = Number(res.headers.get("Content-Length"));
    if (declaredLength > maxBytes * 8) {
      await res.body?.cancel();
      return { ok: false, reason: "页面过大" };
    }

    const bytes = await readBody(res, signal, maxBytes, stopAt);
    return { ok: true, html: decodeHtml(bytes, contentType), finalUrl: current.href };
  }
  return { ok: false, reason: "重定向次数过多" };
}

// stopAt 探测跨块边界时保留的尾部字符数，需不小于要匹配的内容长度。
const PROBE_TAIL_CHARS = 64;

// 读取响应直到 stopAt 匹配、响应结束或达到大小上限。
async function readBody(
  res: Response,
  signal: AbortSignal,
  maxBytes: number,
  stopAt: RegExp | null,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  const probe = stopAt ? new TextDecoder("utf-8") : null;
  let total = 0;
  let tail = "";
  try {
    while (total < maxBytes) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength + total > maxBytes
        ? value.subarray(0, maxBytes - total)
        : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (probe && stopAt) {
        // 只探测 ASCII 标签，非 UTF-8 页面的其他字符被替换也不影响；跨块边界保留少量尾部字符。
        const text = tail + probe.decode(chunk, { stream: true });
        if (stopAt.test(text)) break;
        tail = text.slice(-PROBE_TAIL_CHARS);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const charset =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)))?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export interface RawMetadata {
  documentTitle: string;
  ogTitle: string | null;
  twitterTitle: string | null;
  baseHref: string | null;
  icons: { rel: string; href: string }[];
}

export async function extractMetadata(html: string): Promise<RawMetadata> {
  const meta: RawMetadata = {
    documentTitle: "",
    ogTitle: null,
    twitterTitle: null,
    baseHref: null,
    icons: [],
  };
  let titleSeen = false;
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        if (titleSeen) return;
        titleSeen = true;
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) meta.documentTitle += chunk.text;
      },
    })
    .on("meta", {
      element(el) {
        const key = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
        const content = el.getAttribute("content");
        if (content == null) return;
        if (key === "og:title" && meta.ogTitle == null) meta.ogTitle = content;
        if (key === "twitter:title" && meta.twitterTitle == null) meta.twitterTitle = content;
      },
    })
    .on("base[href]", {
      element(el) {
        meta.baseHref ??= el.getAttribute("href");
      },
    })
    .on("link[rel][href]", {
      element(el) {
        meta.icons.push({
          rel: (el.getAttribute("rel") ?? "").toLowerCase(),
          href: el.getAttribute("href") ?? "",
        });
      },
    });

  await rewriter
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .arrayBuffer();
  return meta;
}

const WECHAT_HOST = "mp.weixin.qq.com";

export function pickTitle(meta: RawMetadata, finalUrl: URL): string | null {
  // 微信文章页面总会提供 og:title；验证页、已删除提示页等没有，此时视为预览失败，
  // 避免把“环境异常”之类的页面标题当作文章标题。
  const candidates =
    finalUrl.hostname === WECHAT_HOST
      ? [meta.ogTitle]
      : [meta.ogTitle, meta.twitterTitle, meta.documentTitle];
  for (const c of candidates) {
    const cleaned = cleanText(c);
    if (cleaned) return cleaned;
  }
  return null;
}

function pickIcon(meta: RawMetadata, finalUrl: URL): string | null {
  let base = finalUrl;
  if (meta.baseHref) {
    try {
      base = new URL(decodeEntities(meta.baseHref), finalUrl);
    } catch {
      // 忽略无效的 <base>
    }
  }
  const rank = (rel: string): number => {
    const tokens = rel.split(/\s+/);
    if (tokens.includes("icon")) return 0; // 包括 "shortcut icon"
    if (tokens.includes("apple-touch-icon") || tokens.includes("apple-touch-icon-precomposed")) {
      return 1;
    }
    return -1;
  };
  const icons = meta.icons
    .map((i) => ({ ...i, rank: rank(i.rel) }))
    .filter((i) => i.rank >= 0)
    .sort((a, b) => a.rank - b.rank);

  for (const icon of icons) {
    const href = decodeEntities(icon.href).trim();
    if (!href) continue;
    try {
      const url = new URL(href, base);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.href.length <= MAX_ICON_URL_LENGTH) {
        return url.href;
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return new URL("/favicon.ico", finalUrl).href;
}

export function cleanText(value: string | null): string | null {
  if (value == null) return null;
  let text = decodeEntities(value)
    .replace(/[\u0000-\u001f\u007f​-‍﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > MAX_TITLE_LENGTH) text = text.slice(0, MAX_TITLE_LENGTH - 1) + "…";
  return text;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

// HTMLRewriter 返回的文本与属性值保留原始实体，这里按 HTML 规则解码一次。
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return "�";
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}
