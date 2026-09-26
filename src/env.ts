export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // 以下三项通过 `wrangler secret put` 配置，不写入源码或 wrangler 配置。
  APP_PASSWORD: string;
  UPLOAD_KEY: string;
  SESSION_SECRET: string;
  // 可选：预览请求总时限（毫秒），默认 8000。
  PREVIEW_TIMEOUT_MS?: string;
}
