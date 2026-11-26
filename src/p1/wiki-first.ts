import type { DatabaseSync } from '../sqlite.js';
import { withTx } from '../db.js';
import { searchChunks } from '../queries.js';
import { WikiFirstOptions } from './contracts.js';
import type { WikiFirstResult, WikiHit } from './contracts.js';
import { NotImplementedError } from './errors.js';

function toFtsMatch(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '')}"`)
    .join(' ');
}

/**
 * FTS 代理分：仅用于骨架阶段验证路由，相关性语义由 P1 向量通道替换。
 * 上限 0.5 —— 因此 θ_wiki 初值 0.75 在代理模式下必然回落 source（I20 的失败关闭），
 * 避免用未标定的分数冒充已标定的相关性。
 */
function proxyScore(bm25Rank: number): number {
  return 1 / (2 + Math.abs(bm25Rank));
}

/** 骨架同步入口：由 compiler.index 阶段调用；skipTx 供外层批量索引合并事务 */
export function indexWikiPageForSearch(
  db: DatabaseSync,
  page: { id: string; title: string; summary: string | null; body: string },
  skipTx = false,
): void {
  const write = (): void => {
    db.prepare('DELETE FROM wiki_pages_fts WHERE page_id = ?').run(page.id);
    db.prepare(
      'INSERT INTO wiki_pages_fts (page_id, title, summary, body) VALUES (?, ?, ?, ?)',
    ).run(page.id, page.title, page.summary, page.body);
  };
  if (skipTx) write();
  else withTx(db, write);
}

/**
 * wiki-first 递归检索骨架（07 §1.4）。
 * 路由与 source 兜底是真实的；相关性分数目前是 FTS 代理，
 * score_mode='vector' 明确未实现，接入 sqlite-vec 后才可与 θ_wiki 的标定语义对齐。
 */
export function searchWikiFirst(
  db: DatabaseSync,
  query: string,
  rawOptions: Partial<WikiFirstOptions> = {},
): WikiFirstResult {
  const options = WikiFirstOptions.parse(rawOptions);
  if (options.score_mode === 'vector') {
    throw new NotImplementedError('wiki-first vector 相关性（待 sqlite-vec 与金标集标定）');
  }

  const match = toFtsMatch(query);
  const wikiHits: WikiHit[] = match
    ? (db
        .prepare(
          `SELECT f.page_id, w.title, w.summary, bm25(wiki_pages_fts) AS rank
             FROM wiki_pages_fts f
             JOIN v_wiki_active w ON w.id = f.page_id
            WHERE wiki_pages_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, options.limit) as Array<{
        page_id: string;
        title: string;
        summary: string | null;
        rank: number;
      }>).map((row) => ({
        page_id: row.page_id,
        title: row.title,
        summary: row.summary,
        score: proxyScore(row.rank),
      }))
    : [];

  const best = wikiHits[0];
  if (best && best.score >= options.theta_wiki) {
    return {
      path: 'wiki',
      wiki_hits: wikiHits,
      source_hits: [],
      theta_wiki: options.theta_wiki,
      score_mode: options.score_mode,
      reason: `wiki 代理分 ${best.score.toFixed(3)} ≥ θ_wiki ${options.theta_wiki}；source 兜底未启用（I20 路径保留）`,
    };
  }

  // I20：wiki 不足时必须回落到 source，禁止用弱 wiki 页顶替原文证据
  const rows = searchChunks(db, query, options.limit);
  return {
    path: rows.length > 0 ? 'source' : 'empty',
    wiki_hits: wikiHits,
    source_hits: rows.map((row) => ({
      id: row.id,
      document_id: row.document_id,
      text: row.text,
      title: row.title,
      path: row.path,
      score: 0, // 骨架阶段未做跨通道归一化，P1 与向量分数统一后才能比较
    })),
    theta_wiki: options.theta_wiki,
    score_mode: options.score_mode,
    reason: best
      ? `wiki 代理分 ${best.score.toFixed(3)} < θ_wiki ${options.theta_wiki}，回落 source`
      : '无可用 wiki 命中，直接回落 source',
  };
}
