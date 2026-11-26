import type { DatabaseSync } from '../sqlite.js';
import { stubFactExtractor } from './ports.js';
import type { FactExtractorPort } from './ports.js';
import { insertFact, upsertEntity } from './knowledge.js';

export interface ExtractStats {
  entities: number;
  facts: number;
}

/** 实体/事实抽取编排：抽取由注入端口决定，写入面（含 proposed 默认）真实 */
export async function extractKnowledge(
  db: DatabaseSync,
  text: string,
  extractor: FactExtractorPort = stubFactExtractor,
): Promise<ExtractStats> {
  const result = await extractor.extract(text);
  for (const entity of result.entities) upsertEntity(db, entity);
  for (const fact of result.facts) insertFact(db, fact);
  return { entities: result.entities.length, facts: result.facts.length };
}
