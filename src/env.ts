export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // 以下三项通过 `wrangler secret put` 配置，不写入源码或 wrangler 配置。
  APP_PASSWORD: string;
  UPLOAD_KEY: string;
  SESSION_SECRET: string;
  // 可选：抓取网页（预览与正文存档）的总时限（毫秒），默认 10000。
  FETCH_TIMEOUT_MS?: string;
  // 可选：导出到 OneNote（见 docs/onenote.md）。两项都设置后才启用。
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  // Microsoft 账户类型：consumers（个人 Microsoft 账户，默认）、organizations 或租户 ID。
  MS_TENANT?: string;
  // 默认笔记本中的分区名称，默认 LinkDock；不存在时自动创建。
  ONENOTE_SECTION?: string;
}
