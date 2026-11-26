import { z } from 'zod';
import { WikiPageDraft } from '../contracts.js';
import type { CompileTrigger } from '../contracts.js';

/** 编译窗口：按时间范围取增量资料；空窗口表示全量 */
export interface SourceWindow {
  from?: number;
  to?: number;
  limit?: number;
}

/** 喂给抽取端口的真实原文块（不含向量与编译产物） */
export interface SourceChunk {
  id: string;
  document_id: string;
  text: string;
  created_at: number;
}

/** 抽取端口输入：窗口条件 + 已经真实取到的原文 */
export interface ExtractWindow extends SourceWindow {
  sources: SourceChunk[];
}

/**
 * 编排阶段契约。默认 stub 全部抛 NotImplementedError，
 * 由 P1 实现时逐个替换；调用方永远走同一个 runCompile 编排。
 */
export interface CompileStages {
  draft(input: SourceWindow): Promise<WikiPageDraft[]>;
  persist(drafts: WikiPageDraft[]): Promise<{ created: number; updated: number }>;
  link(pages: WikiPageDraft[]): Promise<number>;
  index(pages: WikiPageDraft[]): Promise<number>;
}

export interface CompileResult {
  run_id: string;
  trigger: CompileTrigger;
  state: 'done' | 'failed';
  pages_created: number;
  pages_updated: number;
  links_added: number;
  index_entries: number;
  errors: string[];
}

export const DistillInput = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  retrieval_run_id: z.string().optional(),
});
export type DistillInput = z.infer<typeof DistillInput>;

export interface Distiller {
  judge(input: DistillInput): Promise<import('../contracts.js').DistillVerdict>;
  draft(input: DistillInput, verdict: import('../contracts.js').DistillVerdict): Promise<z.input<typeof WikiPageDraft> | null>;
}

export interface WikiLinkToken {
  raw: string;
  title: string;
  line: number;
}

export type ChunkTypeValue = 'source' | 'wiki';

export interface EmbeddingRow {
  chunk_id: string;
  chunk_type: ChunkTypeValue;
  model: string;
  dim: number;
  vector: number[];
}

export interface Embedder {
  model(): string;
  dimension(): number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorHit {
  chunk_id: string;
  chunk_type: ChunkTypeValue;
  score: number;
}

export type EntityType = 'person' | 'org' | 'concept' | 'place' | 'project' | 'artifact';

export interface EntityInput {
  id: string;
  name: string;
  etype: EntityType;
  canonical?: string | null;
}

export interface FactInput {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  evidence_id: string | null;
  origin?: string;
  valid_from?: number | null;
  valid_to?: number | null;
  confidence?: number;
}

export const WikiFirstOptions = z.object({
  limit: z.number().int().min(1).max(100).default(10),
  theta_wiki: z.number().min(0).max(1).default(0.75),
  score_mode: z.enum(['fts_proxy', 'vector']).default('fts_proxy'),
});
export type WikiFirstOptions = z.infer<typeof WikiFirstOptions>;

export interface WikiHit {
  page_id: string;
  title: string;
  summary: string | null;
  score: number;
}

export interface SourceHit {
  id: string;
  document_id: string;
  text: string;
  title: string;
  path: string;
  score: number;
}

export interface WikiFirstResult {
  path: 'wiki' | 'source' | 'empty';
  wiki_hits: WikiHit[];
  source_hits: SourceHit[];
  theta_wiki: number;
  score_mode: WikiFirstOptions['score_mode'];
  reason: string;
}
