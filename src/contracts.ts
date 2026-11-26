import { z } from 'zod';

export const Privacy = z.enum(['llm_ok', 'local_only']);
export type Privacy = z.infer<typeof Privacy>;

export const CreateSourceInput = z.object({
  path: z.string().min(1),
  privacy: Privacy.default('llm_ok'),
  kind: z.literal('local_dir').default('local_dir'),
});
export type CreateSourceInput = z.infer<typeof CreateSourceInput>;

export const HealthOutput = z.object({
  status: z.literal('ok'),
  version: z.string(),
  time: z.number(),
});
export type HealthOutput = z.infer<typeof HealthOutput>;

export const ScanResult = z.object({
  sourceId: z.string(),
  scanned: z.number(),
  indexed: z.number(),
  skipped: z.number(),
  failed: z.number(),
});
export type ScanResult = z.infer<typeof ScanResult>;

export const DocumentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  include_duplicates: z.coerce.number().int().min(0).max(1).default(0),
});
export type DocumentListQuery = z.infer<typeof DocumentListQuery>;

export const SearchQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  include_duplicates: z.coerce.number().int().min(0).max(1).default(0),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SuggestionQuery = z.object({
  status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SuggestionQuery = z.infer<typeof SuggestionQuery>;

export const UpdateSourceIgnoreInput = z.object({
  ignore: z.array(z.string().min(1).max(200)).max(100),
});
export type UpdateSourceIgnoreInput = z.infer<typeof UpdateSourceIgnoreInput>;

// ============ ADR-0009 · LLM Wiki 编译层契约 ============

export const ChunkType = z.enum(['source', 'wiki']);
export type ChunkType = z.infer<typeof ChunkType>;

export const WikiKind = z.enum(['concept', 'project', 'decision', 'incident', 'howto']);
export type WikiKind = z.infer<typeof WikiKind>;

export const WikiStatus = z.enum(['proposed', 'active', 'corrected', 'archived']);
export type WikiStatus = z.infer<typeof WikiStatus>;

export const WikiEvidence = z.object({
  source_type: z.enum(['chunk', 'turn', 'event']),
  source_id: z.string().min(1),
  quote: z.string().min(1),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().positive().optional(),
});
export type WikiEvidence = z.infer<typeof WikiEvidence>;

// 编译产物：默认 proposed；人确认写 updated_by 后方可 active（I18）
export const WikiPageDraft = z.object({
  id: z.string().min(1),
  kind: WikiKind,
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional(),
  body: z.string().min(1),
  status: WikiStatus.default('proposed'),
  evidence: z.array(WikiEvidence).min(1),
  source_refs: z.array(z.string().min(1)).default([]),
  created_by: z.enum(['system', 'user']).default('system'),
  updated_by: z.enum(['system', 'user']).nullable().default(null),
  version: z.number().int().positive().default(1),
});
export type WikiPageDraft = z.infer<typeof WikiPageDraft>;

export const WikiPageQuery = z.object({
  kind: WikiKind.optional(),
  status: WikiStatus.default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type WikiPageQuery = z.infer<typeof WikiPageQuery>;

// 沉淀判定输出（05 §6C.2）：必须同时给标题与摘要，准确率高于纯 true/false
export const DistillVerdict = z.object({
  should_save: z.boolean(),
  title_suggestion: z.string().min(1).max(200).optional(),
  summary: z.string().max(500).optional(),
  signals: z.array(z.enum(['concrete_fact', 'reusable', 'quick_conclusion'])).max(3),
});
export type DistillVerdict = z.infer<typeof DistillVerdict>;

export const CompileTrigger = z.enum(['import', 'qa_distill', 'manual']);
export type CompileTrigger = z.infer<typeof CompileTrigger>;
