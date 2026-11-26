import type { DatabaseSync } from '../sqlite.js';
import { listActiveWikiPages } from '../wiki.js';
import { stubConsistencyChecker } from './ports.js';
import type { ConsistencyChecker } from './ports.js';

export const STUB_TTL_DAYS = 30;

export interface LintReport {
  stale_stubs: number;
  total_links: number;
  duplicate_titles: number;
  checked_pages: number;
  inconsistent_pages: number | null;
  detail: string;
}

/** 失效链接与重复页是纯 SQL 统计，骨架阶段真实实现（M18 的数据来源） */
export function lintStructure(db: DatabaseSync, now = Date.now()): Omit<LintReport, 'inconsistent_pages' | 'checked_pages'> {
  const cutoff = now - STUB_TTL_DAYS * 86_400_000;
  const stale = (
    db
      .prepare('SELECT COUNT(*) AS n FROM wiki_links WHERE dst_page_id IS NULL AND created_at < ?')
      .get(cutoff) as { n: number }
  ).n;
  const total = (db.prepare('SELECT COUNT(*) AS n FROM wiki_links').get() as { n: number }).n;
  const duplicates = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT lower(title) AS t FROM wiki_pages GROUP BY lower(title) HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number }
  ).n;
  return {
    stale_stubs: stale,
    total_links: total,
    duplicate_titles: duplicates,
    detail: `stub > ${STUB_TTL_DAYS} 天 ${stale} / 链接 ${total}；重复标题组 ${duplicates}`,
  };
}

/** 事实一致性需抽检端口；默认未实现，不返回伪造的 100% */
export async function lintWiki(
  db: DatabaseSync,
  checker: ConsistencyChecker = stubConsistencyChecker,
  now = Date.now(),
): Promise<LintReport> {
  const base = lintStructure(db, now);
  const pages = listActiveWikiPages(db);
  const results = await Promise.all(pages.map((page) => checker.check(page.id)));
  const inconsistent = results.filter((result) => !result.consistent).length;
  return {
    ...base,
    checked_pages: pages.length,
    inconsistent_pages: inconsistent,
    detail: `${base.detail}；一致性抽检 ${inconsistent}/${pages.length} 不一致`,
  };
}
