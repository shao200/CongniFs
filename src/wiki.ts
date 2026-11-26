import type { DatabaseSync } from './sqlite.js';
import { withTx } from './db.js';

/**
 * ADR-0009 · P0 立骨：wiki 页的最小数据访问 + I16–I20 运行时检查。
 * 这里不实现 compiler / distiller（P1），只提供被检查的强制点与可测接口。
 */

export interface InvariantCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface WikiPageRow {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  body: string;
  status: string;
  evidence_json: string;
  source_refs: string;
  created_by: string;
  updated_by: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export function insertWikiPage(
  db: DatabaseSync,
  input: {
    id: string;
    kind: string;
    title: string;
    body: string;
    summary?: string;
    evidence: unknown[];
    source_refs?: string[];
    created_by?: 'system' | 'user';
    updated_by?: 'system' | 'user' | null;
    version?: number;
  },
): WikiPageRow | null {
  const now = Date.now();
  const createdBy = input.created_by ?? 'system';
  const updatedBy = input.updated_by ?? null;
  // I18 由数据库触发器强制：系统生成可落 proposed，但未经人确认不得 active
  return withTx(db, () => {
    db.prepare(
      `INSERT INTO wiki_pages
         (id, kind, title, summary, body, status, evidence_json, source_refs,
          created_by, updated_by, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.kind,
      input.title,
      input.summary ?? null,
      input.body,
      'proposed',
      JSON.stringify(input.evidence),
      JSON.stringify(input.source_refs ?? []),
      createdBy,
      updatedBy,
      input.version ?? 1,
      now,
      now,
    );
    return db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(input.id) as unknown as WikiPageRow;
  });
}

/** 人确认：写 updated_by 后方可 active（I18） */
export function confirmWikiPage(
  db: DatabaseSync,
  id: string,
  editor: 'system' | 'user' = 'user',
): boolean {
  return withTx(db, () => {
    const result = db
      .prepare(
        `UPDATE wiki_pages
            SET status = 'active', updated_by = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND status = 'proposed'`,
      )
      .run(editor, Date.now(), id);
    return result.changes > 0;
  });
}

/** I17：目标页不存在时存 stub（dst_page_id = NULL），不静默丢弃；已存在的链接可回填目标 */
export function addWikiLink(
  db: DatabaseSync,
  srcPageId: string,
  dstTitle: string,
  dstPageId: string | null = null,
  weight = 1.0,
): boolean {
  return withTx(db, () => {
    const result = db
      .prepare(
        `INSERT INTO wiki_links
           (src_page_id, dst_title, dst_page_id, link_type, weight, created_at)
         VALUES (?, ?, ?, 'reference', ?, ?)
         ON CONFLICT(src_page_id, dst_title) DO UPDATE SET
           dst_page_id = COALESCE(wiki_links.dst_page_id, excluded.dst_page_id)`,
      )
      .run(srcPageId, dstTitle, dstPageId, weight, Date.now());
    return result.changes > 0;
  });
}

/** 只从 v_wiki_active 取数，禁止直查基表（I16/I17 的 SQL 强制点） */
export function listActiveWikiPages(db: DatabaseSync, limit = 50): WikiPageRow[] {
  return db
    .prepare('SELECT * FROM v_wiki_active WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
    .all('active', limit) as unknown as WikiPageRow[];
}

/** I16–I20 运行时检查；硬否决项失败时 ok=false */
export function checkWikiInvariants(db: DatabaseSync): InvariantCheck[] {
  const checks: InvariantCheck[] = [];

  const noEvidence = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM wiki_pages
          WHERE status = 'active' AND json_array_length(evidence_json) = 0`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: 'I16',
    ok: noEvidence === 0,
    detail: `active 页无 evidence 数 = ${noEvidence}`,
  });

  const stubs = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM wiki_links
          WHERE dst_page_id IS NULL AND weight >= 0.4`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: 'I17',
    ok: true,
    detail: `stub 链接数 = ${stubs}（须标记并巡检，非硬否决）`,
  });

  const unconfirmed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM wiki_pages
          WHERE status = 'active' AND created_by = 'system' AND updated_by IS NULL`,
      )
      .get() as { n: number }
  ).n;
  checks.push({
    id: 'I18',
    ok: unconfirmed === 0,
    detail: `系统生成未确认却 active 数 = ${unconfirmed}`,
  });

  const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
  const hasChunkType = chunkColumns.some((c) => c.name === 'chunk_type');
  checks.push({
    id: 'I19',
    ok: hasChunkType,
    detail: hasChunkType
      ? 'chunks.chunk_type 存在；embedding 模型一致性须在写入编译产物时校验（settings.embedding_model）'
      : 'chunks.chunk_type 缺失，source/wiki 无法区分',
  });

  // I20 仅在实际存在 wiki 内容时要求 source 兜底；空库不应误报
  const hasSource = (() => {
    if (!hasChunkType) return false;
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE chunk_type = 'source'")
      .get() as { n: number };
    return row.n > 0;
  })();
  const wikiCount = (
    db.prepare('SELECT COUNT(*) AS n FROM wiki_pages').get() as { n: number }
  ).n;
  const needsFallback = wikiCount > 0;
  checks.push({
    id: 'I20',
    ok: !needsFallback || hasSource,
    detail: needsFallback
      ? hasSource
        ? 'source 兜底路径的数据基础存在'
        : '有 wiki 页但无 source 块，wiki-first 失败时无兜底（I20 风险）'
      : '无 wiki 内容，跳过 source 兜底检查',
  });

  return checks;
}
