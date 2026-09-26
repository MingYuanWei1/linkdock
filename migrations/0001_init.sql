-- LinkDock 初始数据结构。所有时间均为 Unix 毫秒。

CREATE TABLE links (
  id                 TEXT PRIMARY KEY,
  url                TEXT NOT NULL,
  -- 去重身份：相同身份的提交只保留一个条目（见 src/url.ts）。
  dedup_key          TEXT NOT NULL UNIQUE,
  title              TEXT,
  icon_url           TEXT,
  -- pending：尚未获取；ok：已有有效预览；failed：获取失败，仅显示原链接。
  preview_status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (preview_status IN ('pending', 'ok', 'failed')),
  first_saved_at     INTEGER NOT NULL,
  last_submitted_at  INTEGER NOT NULL,
  submit_count       INTEGER NOT NULL DEFAULT 1,
  -- 排序序号，取自提交时递增后的 meta.version；同一毫秒内的提交也能稳定排序。
  seq                INTEGER NOT NULL
);

CREATE INDEX links_by_seq ON links (seq DESC);

-- 键值计数器：version 在列表任何变化时递增，用作轮询 ETag 与排序序号来源。
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

INSERT INTO meta (key, value) VALUES ('version', 0);

-- 登录失败计数，用于限制密码暴力尝试。
CREATE TABLE login_failures (
  client        TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
