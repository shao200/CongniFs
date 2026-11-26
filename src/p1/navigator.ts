import type { DatabaseSync } from '../sqlite.js';
import { stubNavScorer } from './ports.js';
import type { NavScorer } from './ports.js';

export interface NavResult {
  page_id: string;
  title: string;
  hops: number;
  score: number;
}

/**
 * 沿 wiki_links 多跳导航（P2 能力骨架）：BFS 遍历与 hop 标记真实，
 * 相关性排序由注入 scorer 决定，默认未实现，避免用链接数量冒充相关性。
 */
export async function navigate(
  db: DatabaseSync,
  startPageId: string,
  query: string,
  maxHops = 2,
  scorer: NavScorer = stubNavScorer,
): Promise<NavResult[]> {
  const titleOf = (id: string): string => {
    const row = db.prepare('SELECT title FROM wiki_pages WHERE id = ?').get(id) as
      | { title: string }
      | undefined;
    return row?.title ?? '';
  };

  let frontier = [startPageId];
  const visited = new Set(frontier);
  const results: NavResult[] = [];

  for (let hop = 0; hop <= maxHops && frontier.length > 0; hop += 1) {
    for (const pageId of frontier) {
      results.push({ page_id: pageId, title: titleOf(pageId), hops: hop, score: await scorer.score(query, pageId) });
    }
    const next: string[] = [];
    for (const pageId of frontier) {
      const links = db
        .prepare('SELECT dst_page_id FROM wiki_links WHERE src_page_id = ? AND dst_page_id IS NOT NULL')
        .all(pageId) as Array<{ dst_page_id: string }>;
      for (const link of links) {
        if (visited.has(link.dst_page_id)) continue;
        visited.add(link.dst_page_id);
        next.push(link.dst_page_id);
      }
    }
    frontier = next;
  }

  return results.sort((a, b) => b.score - a.score);
}
