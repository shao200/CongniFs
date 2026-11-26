import { UnknownTaskError } from './errors.js';

/** 08 §1 四层模型；层为 null 表示规则任务，不调用模型。 */
export type ModelLayer = 'T0' | 'T1' | 'T1.5' | 'T2';

export interface TaskRoute {
  task: string;
  layer: ModelLayer | null;
  timeoutMs: number;
  maxTokens: number;
  cacheable: boolean;
}

/**
 * 08 §2 任务路由表（唯一登记处）。
 * 编译层两项 distill_judge / compile_wiki 由 ADR-0009 引入，已登记在此，
 * 回写 08 §2 后生效；未登记任务一律 UNKNOWN_TASK。
 */
export const TASK_ROUTES: Readonly<Record<string, TaskRoute>> = Object.freeze({
  embed: { task: 'embed', layer: 'T0', timeoutMs: 2_000, maxTokens: 0, cacheable: true },
  retrieve: { task: 'retrieve', layer: null, timeoutMs: 500, maxTokens: 0, cacheable: false },
  transcribe: { task: 'transcribe', layer: 'T0', timeoutMs: 30_000, maxTokens: 0, cacheable: true },
  ocr: { task: 'ocr', layer: 'T0', timeoutMs: 10_000, maxTokens: 0, cacheable: true },
  extract_tags: { task: 'extract_tags', layer: 'T1', timeoutMs: 20_000, maxTokens: 2_000, cacheable: true },
  extract_entities: { task: 'extract_entities', layer: 'T1', timeoutMs: 20_000, maxTokens: 2_000, cacheable: true },
  query_rewrite: { task: 'query_rewrite', layer: 'T1', timeoutMs: 10_000, maxTokens: 500, cacheable: true },
  generate_reply: { task: 'generate_reply', layer: 'T1.5', timeoutMs: 30_000, maxTokens: 8_000, cacheable: false },
  probe_wording: { task: 'probe_wording', layer: 'T1.5', timeoutMs: 15_000, maxTokens: 500, cacheable: true },
  summarize_session: { task: 'summarize_session', layer: 'T2', timeoutMs: 120_000, maxTokens: 20_000, cacheable: true },
  detect_tension: { task: 'detect_tension', layer: 'T2', timeoutMs: 60_000, maxTokens: 2_000, cacheable: true },
  fidelity_review: { task: 'fidelity_review', layer: 'T2', timeoutMs: 60_000, maxTokens: 4_000, cacheable: false },
  compress_preferences: { task: 'compress_preferences', layer: 'T2', timeoutMs: 120_000, maxTokens: 8_000, cacheable: true },
  parse: { task: 'parse', layer: null, timeoutMs: 60_000, maxTokens: 0, cacheable: true },
  chunk: { task: 'chunk', layer: null, timeoutMs: 5_000, maxTokens: 0, cacheable: true },
  near_dup: { task: 'near_dup', layer: 'T0', timeoutMs: 5_000, maxTokens: 0, cacheable: true },
  classify_doc: { task: 'classify_doc', layer: 'T1', timeoutMs: 20_000, maxTokens: 3_000, cacheable: true },
  summarize_doc: { task: 'summarize_doc', layer: 'T1', timeoutMs: 45_000, maxTokens: 8_000, cacheable: true },
  organize_suggest: { task: 'organize_suggest', layer: 'T1.5', timeoutMs: 60_000, maxTokens: 6_000, cacheable: false },
  rerank: { task: 'rerank', layer: 'T0', timeoutMs: 300, maxTokens: 0, cacheable: false },
  distill_judge: { task: 'distill_judge', layer: 'T1', timeoutMs: 20_000, maxTokens: 2_000, cacheable: true },
  compile_wiki: { task: 'compile_wiki', layer: 'T1.5', timeoutMs: 45_000, maxTokens: 8_000, cacheable: false },
});

export function resolveRoute(task: string): TaskRoute {
  const route = TASK_ROUTES[task];
  if (!route) throw new UnknownTaskError(task);
  return route;
}
