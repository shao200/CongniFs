import { z } from 'zod';
import { WikiPageDraft as DraftSchema } from '../contracts.js';
import type { DistillVerdict, WikiPageDraft } from '../contracts.js';
import type {
  DistillInput,
  EntityInput,
  ExtractWindow,
  FactInput,
  VectorHit,
} from './contracts.js';
import { NotImplementedError } from './errors.js';

/**
 * P1 所有"需要模型"的能力统一经端口注入。
 * 默认端口全部抛 NotImplementedError：骨架负责编排、取数与落库，不冒充智能。
 */
export interface LLMClient {
  complete(prompt: string, options?: { max_tokens?: number; temperature?: number }): Promise<string>;
}
export const stubLLM: LLMClient = {
  complete: () => Promise.reject(new NotImplementedError('LLMClient.complete（本地模型未接入）')),
};

export interface TopicExtractor {
  extract(input: ExtractWindow): Promise<Array<z.input<typeof DraftSchema>>>;
}
export const stubTopicExtractor: TopicExtractor = {
  extract: () => Promise.reject(new NotImplementedError('TopicExtractor.extract（主题/实体识别需接 LLM）')),
};

export interface DistillGenerator {
  generate(input: DistillInput, verdict: DistillVerdict): Promise<z.input<typeof DraftSchema> | null>;
}
export const stubDistillGenerator: DistillGenerator = {
  generate: () => Promise.reject(new NotImplementedError('DistillGenerator.generate（条目生成需接 LLM）')),
};

export interface FactExtractorPort {
  extract(text: string): Promise<{ entities: EntityInput[]; facts: FactInput[] }>;
}
export const stubFactExtractor: FactExtractorPort = {
  extract: () => Promise.reject(new NotImplementedError('FactExtractorPort.extract（实体/事实抽取需接 LLM）')),
};

export interface VectorIndex {
  search(queryVector: number[], limit: number): Promise<VectorHit[]>;
}
export const stubVectorIndex: VectorIndex = {
  search: () => Promise.reject(new NotImplementedError('VectorIndex.search（待引入 sqlite-vec）')),
};

export interface ConsistencyChecker {
  check(pageId: string): Promise<{ consistent: boolean; detail: string }>;
}
export const stubConsistencyChecker: ConsistencyChecker = {
  check: () => Promise.reject(new NotImplementedError('ConsistencyChecker.check（事实一致性需人工抽检或 LLM）')),
};

export interface NavScorer {
  score(query: string, pageId: string): Promise<number>;
}
export const stubNavScorer: NavScorer = {
  score: () => Promise.reject(new NotImplementedError('NavScorer.score（导航相关性需向量通道）')),
};
