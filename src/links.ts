// 私有列表的持久化操作。每次写入都在同一批次（D1 事务）内递增 meta.version，
// 轮询方据此判断列表是否变化。

export type PreviewStatus = "pending" | "ok" | "failed";

export interface LinkRow {
  id: string;
  url: string;
  dedup_key: string;
  title: string | null;
  icon_url: string | null;
  preview_status: PreviewStatus;
  first_saved_at: number;
  last_submitted_at: number;
  submit_count: number;
  seq: number;
}

export interface LinkView {
  id: string;
  url: string;
  title: string | null;
  iconUrl: string | null;
  previewStatus: PreviewStatus;
  firstSavedAt: number;
  lastSubmittedAt: number;
}

export function toView(row: LinkRow): LinkView {
  const ok = row.preview_status === "ok";
  return {
    id: row.id,
    url: row.url,
    title: ok ? row.title : null,
    iconUrl: ok ? row.icon_url : null,
    previewStatus: row.preview_status,
    firstSavedAt: row.first_saved_at,
    lastSubmittedAt: row.last_submitted_at,
  };
}

const BUMP_VERSION = "UPDATE meta SET value = value + 1 WHERE key = 'version'";

export async function getVersion(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'version'")
    .first<{ value: number }>();
  return row?.value ?? 0;
}

// 插入新条目；相同去重身份已存在时保留原条目并移到顶部。
// 唯一约束保证并发提交也只会得到一个条目。
export async function submitLink(
  db: D1Database,
  url: string,
  dedupKey: string,
  now: number,
): Promise<{ row: LinkRow; created: boolean }> {
  const results = await db.batch<LinkRow>([
    db.prepare(BUMP_VERSION),
    db
      .prepare(
        `INSERT INTO links (id, url, dedup_key, first_saved_at, last_submitted_at, submit_count, seq)
         VALUES (?1, ?2, ?3, ?4, ?4, 1, (SELECT value FROM meta WHERE key = 'version'))
         ON CONFLICT (dedup_key) DO UPDATE SET
           last_submitted_at = excluded.last_submitted_at,
           submit_count = links.submit_count + 1,
           seq = excluded.seq
         RETURNING *`,
      )
      .bind(crypto.randomUUID(), url, dedupKey, now),
  ]);
  const row = results[1].results[0];
  if (!row) throw new Error("写入链接后未返回条目");
  return { row, created: row.submit_count === 1 };
}

export interface ListOptions {
  query: string;
  limit: number;
}

export async function listLinks(
  db: D1Database,
  { query, limit }: ListOptions,
): Promise<{ rows: LinkRow[]; hasMore: boolean }> {
  const fetchLimit = limit + 1;
  let stmt: D1PreparedStatement;
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    stmt = db
      .prepare(
        `SELECT * FROM links
         WHERE (preview_status = 'ok' AND title LIKE ?1 ESCAPE '\\') OR url LIKE ?1 ESCAPE '\\'
         ORDER BY seq DESC LIMIT ?2`,
      )
      .bind(pattern, fetchLimit);
  } else {
    stmt = db.prepare("SELECT * FROM links ORDER BY seq DESC LIMIT ?1").bind(fetchLimit);
  }
  const { results } = await stmt.all<LinkRow>();
  return { rows: results.slice(0, limit), hasMore: results.length > limit };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function getLink(db: D1Database, id: string): Promise<LinkRow | null> {
  return db.prepare("SELECT * FROM links WHERE id = ?1").bind(id).first<LinkRow>();
}

export async function deleteLink(db: D1Database, id: string): Promise<boolean> {
  // 外键已设置级联删除；这里显式删除存档，不依赖外键约束是否开启。
  const results = await db.batch([
    db.prepare("DELETE FROM articles WHERE link_id = ?1").bind(id),
    db.prepare("DELETE FROM links WHERE id = ?1").bind(id),
    db.prepare(`${BUMP_VERSION} AND changes() > 0`),
  ]);
  return results[1].meta.changes > 0;
}

// 只更新仍然存在的条目：预览完成前被删除的条目不会被重新创建。
export async function savePreviewSuccess(
  db: D1Database,
  id: string,
  title: string,
  iconUrl: string | null,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE links SET title = ?2, icon_url = ?3, preview_status = 'ok' WHERE id = ?1",
      )
      .bind(id, title, iconUrl),
    db.prepare(`${BUMP_VERSION} AND changes() > 0`),
  ]);
}

// 失败结果不会覆盖已有的有效预览。
export async function savePreviewFailure(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE links SET preview_status = 'failed' WHERE id = ?1 AND preview_status <> 'ok'",
      )
      .bind(id),
    db.prepare(`${BUMP_VERSION} AND changes() > 0`),
  ]);
}

// ---------- 文章存档 ----------

export interface ArticleRow {
  link_id: string;
  title: string | null;
  byline: string | null;
  content_html: string;
  source_url: string;
  saved_at: number;
}

export async function getArticle(db: D1Database, linkId: string): Promise<ArticleRow | null> {
  return db.prepare("SELECT * FROM articles WHERE link_id = ?1").bind(linkId).first<ArticleRow>();
}

// 阅读视图用：一次查询同时取得条目与存档，减少到数据库的往返次数。
export async function getLinkWithArticle(
  db: D1Database,
  id: string,
): Promise<{ link: LinkRow; article: ArticleRow | null } | null> {
  const row = await db
    .prepare(
      `SELECT l.*, a.link_id AS a_link_id, a.title AS a_title, a.byline AS a_byline,
              a.content_html AS a_content_html, a.source_url AS a_source_url, a.saved_at AS a_saved_at
       FROM links l LEFT JOIN articles a ON a.link_id = l.id
       WHERE l.id = ?1`,
    )
    .bind(id)
    .first<LinkRow & {
      a_link_id: string | null;
      a_title: string | null;
      a_byline: string | null;
      a_content_html: string | null;
      a_source_url: string | null;
      a_saved_at: number | null;
    }>();
  if (!row) return null;
  const { a_link_id, a_title, a_byline, a_content_html, a_source_url, a_saved_at, ...link } = row;
  const article = a_link_id == null ? null : {
    link_id: a_link_id,
    title: a_title,
    byline: a_byline,
    content_html: a_content_html ?? "",
    source_url: a_source_url ?? link.url,
    saved_at: a_saved_at ?? 0,
  };
  return { link, article };
}

export async function hasArticle(db: D1Database, linkId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM articles WHERE link_id = ?1").bind(linkId).first();
  return row != null;
}

// 只为仍然存在的条目保存存档：条目在抓取期间被删除时不会留下孤立存档。
// 返回是否已保存。
export async function saveArticle(
  db: D1Database,
  article: Omit<ArticleRow, "saved_at">,
  savedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO articles (link_id, title, byline, content_html, source_url, saved_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM links WHERE id = ?1)
       ON CONFLICT (link_id) DO UPDATE SET
         title = excluded.title,
         byline = excluded.byline,
         content_html = excluded.content_html,
         source_url = excluded.source_url,
         saved_at = excluded.saved_at`,
    )
    .bind(
      article.link_id,
      article.title,
      article.byline,
      article.content_html,
      article.source_url,
      savedAt,
    )
    .run();
  return result.meta.changes > 0;
}
