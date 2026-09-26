// 抓取链接内容：一次请求同时得到预览（标题、图标）与阅读视图正文，
// 减少对目标网站（尤其是会限制频率的微信）的请求次数。

import { fetchPage, MAX_HTML_BYTES, previewFromHtml, type PreviewOutcome } from "./preview";
import { readableFromHtml, readerFetchOptions, type ReaderOutcome } from "./reader";

export const CONTENT_TIMEOUT_MS = 10_000;

export interface Wanted {
  preview: boolean;
  readable: boolean;
}

export interface LinkContent {
  preview: PreviewOutcome | null;
  readable: ReaderOutcome | null;
}

export async function fetchLinkContent(
  target: string,
  want: Wanted,
  timeoutMs: number = CONTENT_TIMEOUT_MS,
): Promise<LinkContent> {
  const fail = (reason: string): LinkContent => ({
    preview: want.preview ? { ok: false, reason } : null,
    readable: want.readable ? { ok: false, reason } : null,
  });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // 只需要预览时读到 </head> 即停止。
    const options = want.readable
      ? readerFetchOptions(target)
      : { maxBytes: MAX_HTML_BYTES, stopAt: /<\/head\s*>/i };
    const fetched = await fetchPage(target, signal, options);
    if (!fetched.ok) return fail(fetched.reason);
    const finalUrl = new URL(fetched.finalUrl);
    return {
      preview: want.preview ? await previewFromHtml(headOf(fetched.html), finalUrl) : null,
      readable: want.readable ? await readableFromHtml(fetched.html, finalUrl) : null,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return fail(name === "TimeoutError" || name === "AbortError" ? "请求超时" : "请求失败");
  }
}

// 预览只看文档头部（且不超过读取上限），与只抓取头部时的结果一致。
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return html.slice(0, Math.min(end === -1 ? html.length : end, MAX_HTML_BYTES));
}
