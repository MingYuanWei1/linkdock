-- OneNote 导出：以本人 Microsoft 账户（委托权限）把存档正文创建为 OneNote 页面。

-- 已连接的 Microsoft 账户（最多一行）。
CREATE TABLE onenote_account (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token   TEXT NOT NULL,
  access_token    TEXT,
  access_expires  INTEGER,
  -- 首次连接时间：此后存档的文章才会导出。重新授权不改变该时间。
  connected_at    INTEGER NOT NULL,
  -- 令牌失效等需要重新连接的原因；正常时为空。
  last_error      TEXT
);

-- 每个链接的导出状态。sending：正在创建页面（用于避免重复导出）；
-- done：已创建页面；failed：失败，定时任务会重试到次数上限。
CREATE TABLE onenote_exports (
  link_id     TEXT PRIMARY KEY REFERENCES links (id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('sending', 'done', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  page_url    TEXT,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
