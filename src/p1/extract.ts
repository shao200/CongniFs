import type { DatabaseSync } from '../sqlite.js';
import { DistillVerdict, WikiPageDraft as DraftSchema } from '../contracts.js';
import type { WikiPageDraft } from '../contracts.js';
import { DistillInput as DistillInputSchema } from './contracts.js';
import type { DistillInput, ExtractWindow, SourceChunk, SourceWindow } from './contracts.js';
import { stubDistillGenerator, stubTopicExtractor } from './ports.js';
import type { DistillGenerator, TopicExtractor } from './ports.js';
import { evaluateVerdict } from './distiller.js';

/** 真实取数：按窗口从 source 块取原文；过滤与排序确定性，不涉及模型 */
export function readSourceWindow(db: DatabaseSync, window: SourceWindow = {}): SourceChunk[] {
  return db
    .prepare(
      `SELECT c.id, c.document_id, c.text, d.created_at
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.chunk_type = 'source'
          AND (? IS NULL OR d.created_at >= ?)
          AND (? IS NULL OR d.created_at <= ?)
        ORDER BY d.created_at, c.ordinal
        LIMIT ?`,
    )
    .all(
      window.from ?? null,
      window.from ?? null,
      window.to ?? null,
      window.to ?? null,
      window.limit ?? 50,
    ) as unknown as SourceChunk[];
}

/** 主题/实体识别编排：取数与契约校验真实，识别本身由注入的 extractor 决定 */
export async function extractDrafts(
  db: DatabaseSync,
  window: SourceWindow = {},
  extractor: TopicExtractor = stubTopicExtractor,
): Promise<WikiPageDraft[]> {
  const sources = readSourceWindow(db, window);
  if (sources.length === 0) return [];
  const input: ExtractWindow = { ...window, sources };
  const drafts = await extractor.extract(input);
  return DraftSchema.array().parse(drafts);
}

/** 条目生成编排：保守判定真实；生成由注入端口决定，产物强制 proposed + evidence */
export async function generateDistillDraft(
  input: DistillInput,
  verdict: DistillVerdict,
  generator: DistillGenerator = stubDistillGenerator,
): Promise<WikiPageDraft | null> {
  if (!evaluateVerdict(verdict)) return null;
  const draft = await generator.generate(DistillInputSchema.parse(input), verdict);
  if (!draft) return null;
  return DraftSchema.parse({
    ...draft,
    status: 'proposed',
    created_by: 'system',
    updated_by: null,
  });
}
