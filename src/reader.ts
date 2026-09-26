// 阅读视图：从抓取到的网页中提取正文并按白名单清理，生成可在站内显示与存档的 HTML。
//
// 这是整理后的文章副本，不是原网页：不运行原网页脚本，不包含视频、评论等交互内容。
// 安全措施分三层：
//   1. 本模块只输出白名单内的标签与属性，脚本、框架、表单、原始文本元素整段丢弃，
//      链接与图片地址只允许 http(s)；
//   2. 阅读页响应带有严格 CSP（禁止任何脚本）和 CSP sandbox；
//   3. 网页端用不含 allow-scripts / allow-same-origin 的 sandbox iframe 加载阅读页。

import { cleanText, decodeEntities, extractMetadata, pickTitle, type FetchPageOptions } from "./preview";

const MAX_PAGE_BYTES = 6 * 1024 * 1024;
// 非微信页面只解析前 2 MiB，控制 CPU 时间。
const MAX_GENERIC_PARSE_CHARS = 2 * 1024 * 1024;
const MIN_TEXT_LENGTH = 40;

const WECHAT_HOST = "mp.weixin.qq.com";
// 微信文章页中紧跟正文之后的区域（据 2026-09 实际页面）。
const WECHAT_AFTER_CONTENT_IDS = ["js_pc_qr_code", "js_tags_preview_toast", "content_bottom_area"];
const MAX_WECHAT_SLICE_CHARS = 2 * 1024 * 1024;
const WECHAT_STOP_AT = new RegExp(`id="(?:${WECHAT_AFTER_CONTENT_IDS.join("|")})"`);

export interface Readable {
  title: string | null;
  byline: string | null;
  contentHtml: string;
  finalUrl: string;
}

export type ReaderOutcome = { ok: true; readable: Readable } | { ok: false; reason: string };

// 阅读视图所需的抓取范围。微信页面约 3.5 MB，正文在前 1 MB 内：读到正文之后的区域即停止。
export function readerFetchOptions(target: string): FetchPageOptions {
  const stopAt = new URL(target).hostname === WECHAT_HOST ? WECHAT_STOP_AT : null;
  return { maxBytes: MAX_PAGE_BYTES, stopAt };
}

export async function readableFromHtml(html: string, finalUrl: URL): Promise<ReaderOutcome> {
  return finalUrl.hostname === WECHAT_HOST ? readWeChat(html, finalUrl) : readGeneric(html, finalUrl);
}

async function readWeChat(html: string, finalUrl: URL): Promise<ReaderOutcome> {
  const marker = html.indexOf('id="js_content"');
  if (marker === -1) {
    return {
      ok: false,
      reason: "微信没有返回文章内容（文章可能已删除、需要验证，或微信暂时限制了访问）",
    };
  }
  // 只解析正文附近的一段以节省 CPU：结束于正文之后的已知区域（二维码、底部栏等），
  // 找不到时退回到其后第一个 <script>。根元素未闭合时 HTMLRewriter 会取到片段末尾。
  const start = html.lastIndexOf("<", marker);
  const after = WECHAT_AFTER_CONTENT_IDS
    .map((id) => html.indexOf(`id="${id}"`, marker))
    .filter((i) => i !== -1);
  let end = after.length ? html.lastIndexOf("<", Math.min(...after)) : html.indexOf("<script", marker);
  if (end <= start) end = html.length;
  const slice = html.slice(start, Math.min(end, start + MAX_WECHAT_SLICE_CHARS));

  const { html: contentHtml, textLength, images } = await sanitize(slice, finalUrl, {
    matchesRoot: (el) => el.getAttribute("id") === "js_content",
  });
  if (textLength < MIN_TEXT_LENGTH && images === 0) {
    return { ok: false, reason: "微信文章内容为空（可能是视频、图片消息或需要在微信中打开）" };
  }

  const headEnd = html.search(/<\/head\s*>/i);
  const meta = await extractMetadata(headEnd === -1 ? html.slice(0, 200_000) : html.slice(0, headEnd));
  const byline = /id="js_name"[^>]*>([^<]*)</.exec(html.slice(0, start + 1))?.[1] ??
    /id="js_name"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

  return {
    ok: true,
    readable: {
      title: pickTitle(meta, finalUrl),
      byline: cleanText(byline),
      contentHtml,
      finalUrl: finalUrl.href,
    },
  };
}

async function readGeneric(html: string, finalUrl: URL): Promise<ReaderOutcome> {
  const source = html.slice(0, MAX_GENERIC_PARSE_CHARS);
  const meta = await extractMetadata(source);

  // 优先 <article>，其次 <main>，最后整个 <body>。
  const candidates = ["article", "main", "body"].filter(
    (tag) => tag === "body" || new RegExp(`<${tag}[\\s>]`, "i").test(source),
  );
  for (const tag of candidates) {
    const result = await sanitize(source, finalUrl, { matchesRoot: (el) => el.tagName === tag });
    if (result.textLength >= MIN_TEXT_LENGTH || (tag === "body" && result.images > 0)) {
      return {
        ok: true,
        readable: {
          title: pickTitle(meta, finalUrl),
          byline: null,
          contentHtml: result.html,
          finalUrl: finalUrl.href,
        },
      };
    }
  }
  return { ok: false, reason: "页面没有可显示的正文（可能需要脚本渲染或登录）" };
}

// ---------- 清理 ----------

// 保留的标签；不在此列、也不在 DROP 中的标签只去掉标签本身，保留其中内容。
const ALLOWED = new Set([
  "p", "div", "span", "section", "article", "main", "header", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "sub", "sup", "mark", "small", "big",
  "br", "hr", "blockquote", "pre", "code", "kbd", "samp", "abbr", "cite", "q", "time", "center",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "figure", "figcaption", "img", "a",
]);

// 整段丢弃（包括内容）的标签：脚本、样式、原始文本元素、框架、表单、外部内容与交互控件。
const DROP = new Set([
  "script", "style", "noscript", "template", "textarea", "title", "xmp", "plaintext",
  "iframe", "frame", "frameset", "noframes", "noembed", "object", "embed", "applet",
  "svg", "math", "canvas", "audio", "video", "picture", "source", "track", "map",
  "form", "input", "button", "select", "option", "label", "dialog", "menu",
  "nav", "aside", "head", "meta", "link", "base",
]);

const ALWAYS_ATTRS = ["title", "width", "height", "colspan", "rowspan", "align", "valign", "lang", "dir"];

interface SanitizeOptions {
  matchesRoot: (el: Element) => boolean;
}

interface SanitizeResult {
  html: string;
  textLength: number;
  images: number;
}

// 由 HTMLRewriter 完成删除与改写（它能正确处理省略的结束标签、SVG 自闭合等情况），
// 再用一次性随机标记截取根元素的输出。
async function sanitize(source: string, base: URL, { matchesRoot }: SanitizeOptions): Promise<SanitizeResult> {
  const nonce = crypto.randomUUID();
  const startMarker = `<!--linkdock-start-${nonce}-->`;
  const endMarker = `<!--linkdock-end-${nonce}-->`;
  let rootFound = false;

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (!rootFound && matchesRoot(el)) {
          rootFound = true;
          el.tagName = "div";
          stripAttributes(el);
          el.before(startMarker, { html: true });
          el.onEndTag((end) => {
            end.after(endMarker, { html: true });
          });
          return;
        }
        if (DROP.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED.has(tag)) {
          el.removeAndKeepContent(); // 仅去掉标签，保留内容
          return;
        }
        const attrs = allowedAttributes(tag, el, base);
        if (attrs == null) {
          el.remove();
          return;
        }
        stripAttributes(el);
        // setAttribute 会转义引号但不转义 &，因此先转义 &。
        for (const [name, value] of attrs) el.setAttribute(name, value.replace(/&/g, "&amp;"));
      },
    })
    .onDocument({
      comments(comment) {
        comment.remove();
      },
    });

  // 源码中若恰好含有同样的注释也会被上面的处理删除，标记只可能来自本次插入。
  const output = await rewriter
    .transform(new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  const from = output.indexOf(startMarker);
  if (from === -1) return { html: "", textLength: 0, images: 0 };
  const to = output.indexOf(endMarker, from);
  const html = output.slice(from + startMarker.length, to === -1 ? undefined : to);

  const text = html.replace(/<[^>]*>/g, "").replace(/&[#\w]+;/g, " ").replace(/\s+/g, "");
  return { html, textLength: text.length, images: (html.match(/<img\s/g) ?? []).length };
}

function stripAttributes(el: Element): void {
  const names = [...el.attributes].map(([name]) => name);
  for (const name of names) el.removeAttribute(name);
}

// 返回清理后的属性（值为已解码的纯文本）；返回 null 表示整个元素应删除（如没有有效地址的图片）。
function allowedAttributes(tag: string, el: Element, base: URL): [string, string][] | null {
  const attrs: [string, string][] = [];
  for (const name of ALWAYS_ATTRS) {
    const v = el.getAttribute(name);
    if (v != null && v.length <= 200) attrs.push([name, decodeEntities(v)]);
  }
  const style = sanitizeStyle(el.getAttribute("style"));
  if (style) attrs.push(["style", style]);

  if (tag === "a") {
    const href = safeUrl(el.getAttribute("href"), base, true);
    if (href) {
      attrs.push(["href", href], ["target", "_blank"], ["rel", "noopener noreferrer"]);
    }
  } else if (tag === "img") {
    // 微信等页面把真实地址放在 data-src，由脚本延迟加载。
    const src = safeUrl(el.getAttribute("data-src"), base, false) ??
      safeUrl(el.getAttribute("src"), base, false);
    if (!src) return null;
    attrs.push(["src", src], ["loading", "lazy"], ["referrerpolicy", "no-referrer"]);
    const alt = el.getAttribute("alt");
    if (alt != null) attrs.push(["alt", decodeEntities(alt).slice(0, 300)]);
  }
  return attrs;
}

function safeUrl(raw: string | null, base: URL, allowMailto: boolean): string | null {
  if (!raw) return null;
  const value = decodeEntities(raw).trim();
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    if (allowMailto && url.protocol === "mailto:") return url.href;
  } catch {
    // 无效地址直接丢弃
  }
  return null;
}

// 保留排版样式，去掉让内容不可见（微信正文默认隐藏，等脚本显示）或可能加载外部资源的写法。
function sanitizeStyle(raw: string | null): string | null {
  if (!raw) return null;
  const value = decodeEntities(raw);
  if (value.length > 2000) return null;
  const kept = value
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      if (!d) return false;
      const lower = d.toLowerCase();
      if (/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/.test(lower)) return false;
      if (/^(visibility|opacity|display|position|z-index|pointer-events|content)\s*:/.test(lower)) {
        return false;
      }
      return /^[a-z-]+\s*:/.test(lower);
    });
  return kept.length ? kept.join("; ") : null;
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
