import type { DatabaseSync } from '../sqlite.js';
import { addWikiLink } from '../wiki.js';
import type { WikiLinkToken } from './contracts.js';
import { NotImplementedError } from './errors.js';

const LINK_RE = /\[\[([^\[\]\n]+)\]\]/g;

/** 解析 [[标题]]；返回原始 token 供 addWikiLink 直接落库（I17：不存在即 stub） */
export function parseWikiLinks(text: string): WikiLinkToken[] {
  const tokens: WikiLinkToken[] = [];
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(text)) !== null) {
    const title = match[1].trim();
    if (!title) continue;
    tokens.push({
      raw: match[0],
      title,
      line: text.slice(0, match.index).split('\n').length,
    });
  }
  return tokens;
}

/** 建边骨架：解析出的链接全部落库，目标不存在时保留 stub，不静默丢弃 */
export function linkWikiPage(db: DatabaseSync, srcPageId: string, tokens: WikiLinkToken[]): number {
  let added = 0;
  for (const token of tokens) {
    if (addWikiLink(db, srcPageId, token.raw, null, 1.0)) added += 1;
  }
  return added;
}

export interface StubResolver {
  resolve(title: string): Promise<string | null>;
}

export const stubResolver: StubResolver = {
  resolve: () => Promise.reject(new NotImplementedError('wiki-linker.resolveStubs（标题消歧未实现）')),
};

/** 确定性消歧：仅做标题精确匹配；同义/模糊匹配仍需 LLM 端口，不在此冒充 */
export function exactTitleResolver(db: DatabaseSync): StubResolver {
  return {
    resolve: async (rawTitle) => {
      const title = rawTitle.replace(/^\[\[/, '').replace(/\]\]$/, '').trim();
      const row = db.prepare('SELECT id FROM wiki_pages WHERE title = ?').get(title) as
        | { id: string }
        | undefined;
      return row?.id ?? null;
    },
  };
}

/** stub 回填骨架：解析策略由注入的 resolver 决定；默认未实现 */
export async function resolveStubs(db: DatabaseSync, resolver: StubResolver = stubResolver): Promise<number> {
  const stubs = db
    .prepare('SELECT src_page_id, dst_title FROM wiki_links WHERE dst_page_id IS NULL')
    .all() as Array<{ src_page_id: string; dst_title: string }>;
  let resolved = 0;
  for (const stub of stubs) {
    const pageId = await resolver.resolve(stub.dst_title);
    if (!pageId) continue;
    db.prepare(
      `UPDATE wiki_links SET dst_page_id = ? WHERE src_page_id = ? AND dst_title = ?`,
    ).run(pageId, stub.src_page_id, stub.dst_title);
    resolved += 1;
  }
  return resolved;
}
