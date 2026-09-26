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
  const results = await db.batch([
    db.prepare("DELETE FROM links WHERE id = ?1").bind(id),
    db.prepare(`${BUMP_VERSION} AND changes() > 0`),
  ]);
  return results[0].meta.changes > 0;
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
