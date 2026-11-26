import type { DatabaseSync } from '../sqlite.js';
import { withTx } from '../db.js';
import { indexWikiPageForSearch } from './wiki-first.js';

export interface IndexablePage {
  id: string;
  kind: string;
  title: string;
  summary?: string | null;
  body: string;
}

/**
 * index.md 的结构化表示生成（07 §1.4 / 04 §5.12）。
 * 这是确定性逻辑，骨架阶段就真实实现；按标题排序保证同一输入同一结果。
 */
export function indexWikiPages(db: DatabaseSync, pages: IndexablePage[]): number {
  const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title));
  const byKind = new Map<string, IndexablePage[]>();
  for (const page of sorted) {
    const group = byKind.get(page.kind) ?? [];
    group.push(page);
    byKind.set(page.kind, group);
  }

  withTx(db, () => {
    const statement = db.prepare(
      `INSERT INTO wiki_index (id, kind, title, summary, page_ids, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, summary = excluded.summary,
         page_ids = excluded.page_ids, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    for (const [kind, group] of byKind) {
      statement.run(
        `idx_topic_${kind}`,
        'topic',
        `主题：${kind}`,
        `共 ${group.length} 页`,
        JSON.stringify(group.map((page) => page.id)),
        now,
      );
    }
    statement.run(
      'idx_global',
      'global',
      '全局索引',
      `共 ${sorted.length} 页`,
      JSON.stringify(sorted.map((page) => page.id)),
      now,
    );

    for (const page of sorted) {
      indexWikiPageForSearch(
        db,
        { id: page.id, title: page.title, summary: page.summary ?? null, body: page.body },
        true,
      );
    }
  });

  return byKind.size + 1;
}
