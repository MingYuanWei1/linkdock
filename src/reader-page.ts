// 阅读页 HTML 模板。页面不含任何脚本；正文来自 reader.ts 的白名单清理结果。

import { escapeText } from "./reader";

// 禁止一切脚本与外部资源（图片除外），并以 CSP sandbox 运行：即使直接在新标签页打开也是隔离的源。
export const READER_CSP = [
  "default-src 'none'",
  "img-src https: http: data:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-popups allow-popups-to-escape-sandbox",
].join("; ");

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #fbfbf9;
  color: #262626;
  font: 17px/1.75 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
  overflow-wrap: anywhere;
}
.reader { max-width: 720px; margin: 0 auto; padding: 20px 16px 48px; }
.reader > h1 { font-size: 24px; line-height: 1.4; margin: 0 0 8px; }
.byline { margin: 0 0 24px; font-size: 14px; color: #8a8a8a; }
.content { max-width: 100%; }
.content * { max-width: 100% !important; box-sizing: border-box !important; }
.content img { height: auto !important; border-radius: 4px; vertical-align: middle; }
.content p { margin: 0 0 1em; }
.content a { color: #2f6fed; }
.content pre { overflow-x: auto; white-space: pre-wrap; background: #f1f1ee; padding: 12px; border-radius: 6px; }
.content table { display: block; overflow-x: auto; border-collapse: collapse; }
.content td, .content th { border: 1px solid #e3e3e0; padding: 4px 8px; }
.content blockquote { margin: 0 0 1em; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
.foot { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e8e8e5; font-size: 14px; color: #8a8a8a; }
.foot a, .actions a { color: #2f6fed; }
.message { max-width: 520px; margin: 18vh auto 0; padding: 0 20px; text-align: center; }
.message h1 { font-size: 20px; margin: 0 0 8px; }
.message p { color: #6b6b6b; margin: 0 0 20px; }
.actions { display: flex; gap: 20px; justify-content: center; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escapeText(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function renderReaderPage(page: {
  title: string | null;
  byline: string | null;
  contentHtml: string;
  originalUrl: string;
}): string {
  const title = page.title ?? page.originalUrl;
  const source = [page.byline, domainOf(page.originalUrl)].filter(Boolean).join(" · ");
  const original = escapeAttr(page.originalUrl);
  return shell(
    title,
    `<main class="reader">
<h1>${escapeText(title)}</h1>
<p class="byline">${escapeText(source)}</p>
<div class="content">${page.contentHtml}</div>
<p class="foot">这是链接坞整理的阅读视图，可能缺少视频、评论等互动内容。<a href="${original}" target="_blank" rel="noopener noreferrer">打开原网页</a></p>
</main>`,
  );
}

export function renderReaderMessage(msg: {
  heading: string;
  message?: string;
  originalUrl?: string;
}): string {
  // 不提供页内“重试”链接：iframe 内的跳转会进入浏览器历史，使“返回”先在 iframe 中后退。
  const actions: string[] = [];
  if (msg.originalUrl) {
    actions.push(
      `<a href="${escapeAttr(msg.originalUrl)}" target="_blank" rel="noopener noreferrer">打开原网页</a>`,
    );
  }
  return shell(
    msg.heading,
    `<div class="message">
<h1>${escapeText(msg.heading)}</h1>
${msg.message ? `<p>${escapeText(msg.message)}</p>` : ""}
${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
</div>`,
  );
}
