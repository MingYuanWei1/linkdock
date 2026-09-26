-- 阅读视图的文章存档：每个链接最多一份整理后的正文（图片仍从原网站加载）。

CREATE TABLE articles (
  link_id       TEXT PRIMARY KEY REFERENCES links (id) ON DELETE CASCADE,
  title         TEXT,
  byline        TEXT,
  -- 经白名单清理的正文 HTML（见 src/reader.ts）。
  content_html  TEXT NOT NULL,
  -- 抓取时跟随重定向后的最终地址。
  source_url    TEXT NOT NULL,
  saved_at      INTEGER NOT NULL
);
