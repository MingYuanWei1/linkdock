export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // 以下三项通过 `wrangler secret put` 配置，不写入源码或 wrangler 配置。
  APP_PASSWORD: string;
  UPLOAD_KEY: string;
  SESSION_SECRET: string;
  // 可选：抓取网页（预览与正文存档）的总时限（毫秒），默认 10000。
  FETCH_TIMEOUT_MS?: string;
}
