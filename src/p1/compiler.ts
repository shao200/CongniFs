import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../sqlite.js';
import type { CompileTrigger, WikiPageDraft } from '../contracts.js';
import { insertWikiPage } from '../wiki.js';
import type { CompileResult, CompileStages, SourceWindow } from './contracts.js';
import { NotImplementedError } from './errors.js';
import { indexWikiPages } from './indexer.js';
import { linkWikiPage, parseWikiLinks } from './wiki-linker.js';

/**
 * 编译编排骨架：runCompile 的生命周期是真实的（compile_runs 只增 + 失败留痕），
 * 四个阶段默认全部未实现，P1 实现时逐个注入替换，不改变编排顺序。
 */
export function stubStages(): CompileStages {
  return {
    draft: () => Promise.reject(new NotImplementedError('compiler.draft（主题/实体识别需接 LLM）')),
    persist: () => Promise.reject(new NotImplementedError('compiler.persist（草稿落库需实现 I16/I18 强制点）')),
    link: () => Promise.reject(new NotImplementedError('compiler.link（wiki-linker 未接入）')),
    index: () => Promise.reject(new NotImplementedError('compiler.index（wiki_index 生成未实现）')),
  };
}

export async function runCompile(
  db: DatabaseSync,
  trigger: CompileTrigger,
  stages: CompileStages = stubStages(),
  window: SourceWindow = {},
  generator: string | null = null,
): Promise<CompileResult> {
  const runId = `cr_${randomUUID()}`;
  const result: CompileResult = {
    run_id: runId,
    trigger,
    state: 'done',
    pages_created: 0,
    pages_updated: 0,
    links_added: 0,
    index_entries: 0,
    errors: [],
  };

  db.prepare(
    `INSERT INTO compile_runs
       (id, trigger, window_from, window_to, pages_created, pages_updated,
        links_added, index_entries, generator, errors, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, NULL, ?)`,
  ).run(runId, trigger, window.from ?? null, window.to ?? null, generator, Date.now());

  try {
    const drafts = await stages.draft(window);
    const persisted = await stages.persist(drafts);
    const linksAdded = await stages.link(drafts);
    const indexEntries = await stages.index(drafts);

    result.pages_created = persisted.created;
    result.pages_updated = persisted.updated;
    result.links_added = linksAdded;
    result.index_entries = indexEntries;

    db.prepare(
      `UPDATE compile_runs
          SET pages_created = ?, pages_updated = ?, links_added = ?, index_entries = ?
        WHERE id = ?`,
    ).run(result.pages_created, result.pages_updated, result.links_added, result.index_entries, runId);
  } catch (error) {
    // 失败关闭：不让半批产物静默通过；调用方必须检查 state
    result.state = 'failed';
    result.errors = [error instanceof Error ? error.message : String(error)];
    db.prepare('UPDATE compile_runs SET errors = ? WHERE id = ?').run(
      JSON.stringify(result.errors),
      runId,
    );
  }

  return result;
}

/**
 * 半确定性阶段组合：persist / link / index 都真实落库，
 * 只有 draft（主题识别）仍需 LLM 端口。用于在没有模型时验证编译后半程。
 */
export function deterministicStages(db: DatabaseSync): CompileStages {
  return {
    draft: () => Promise.reject(new NotImplementedError('compiler.draft（仍需注入 TopicExtractor）')),
    persist: async (drafts: WikiPageDraft[]) => {
      let created = 0;
      for (const draft of drafts) {
        insertWikiPage(db, {
          id: draft.id,
          kind: draft.kind,
          title: draft.title,
          body: draft.body,
          summary: draft.summary,
          evidence: draft.evidence,
          source_refs: draft.source_refs,
          created_by: draft.created_by,
          updated_by: draft.updated_by,
          version: draft.version,
        });
        created += 1;
      }
      return { created, updated: 0 };
    },
    link: async (pages: WikiPageDraft[]) => {
      let added = 0;
      for (const page of pages) added += linkWikiPage(db, page.id, parseWikiLinks(page.body));
      return added;
    },
    index: async (pages: WikiPageDraft[]) => indexWikiPages(db, pages),
  };
}
