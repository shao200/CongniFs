import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from '../sqlite.js';
import { DistillVerdict, WikiPageDraft as DraftSchema } from '../contracts.js';
import type { DistillVerdict as DistillVerdictType, WikiPageDraft } from '../contracts.js';
import { callTask } from '../llm/gateway.js';
import type { CallOptions } from '../llm/gateway.js';
import type { LLMConfig } from '../llm/config.js';
import type { Distiller } from './contracts.js';
import type { DistillInput, EntityInput, ExtractWindow, FactInput } from './contracts.js';
import type {
  DistillGenerator,
  FactExtractorPort,
  LLMClient,
  TopicExtractor,
} from './ports.js';

/**
 * 四个模型端口的 HTTP 实现骨架。
 * 共同约束：
 * 1. 模型身份/价格来自仓库外配置，未启用则 callTask 拒绝外呼；
 * 2. prompt 版本 = 内容哈希（08 §7.2）；
 * 3. 输出经 Zod 强校验，evidence 必须能在输入原文中定位，不采信幻觉引用（M3）。
 */

const TOPIC_TEMPLATE = `你是知识编译器的主题识别阶段。只使用下方 <SOURCE> 内的原文，禁止使用常识补充。
输出严格 JSON 数组，每项字段：id, kind(concept|project|decision|incident|howto), title, summary, body,
evidence: [{source_type:"chunk", source_id, quote}], source_refs: [source_id]。
每条 evidence 的 quote 必须是对应原文中的连续片段，source_id 必须来自给定块。无主题则输出 []。
<SOURCES>
{{SOURCES}}
</SOURCES>`;

const JUDGE_TEMPLATE = `判断是否值得沉淀为 Wiki 条目。只依据给定问答，输出严格 JSON：
{"should_save": boolean, "title_suggestion": string, "summary": string,
 "signals": ["concrete_fact"|"reusable"|"quick_conclusion"]}。
signals 必须有实质依据；少于 2 个信号应判 should_save=false。
<QUESTION>{{QUESTION}}</QUESTION>
<ANSWER>{{ANSWER}}</ANSWER>`;

const WIKI_TEMPLATE = `把问答改写为一条 Wiki 草稿。只使用给定内容，禁止补写未提供的事实。
输出严格 JSON：{id, kind, title, summary, body,
 evidence:[{source_type:"turn", source_id:"{{RUN_ID}}", quote}], source_refs:[]}。
quote 必须是 ANSWER 中的连续片段。
<QUESTION>{{QUESTION}}</QUESTION>
<ANSWER>{{ANSWER}}</ANSWER>
<VERDICT>{{VERDICT}}</VERDICT>`;

const FACT_TEMPLATE = `从原文抽取实体与事实。只输出严格 JSON：
{"entities":[{id,name,etype(person|org|concept|place|project|artifact),canonical}],
 "facts":[{id,subject,predicate,object,evidence_id,origin,confidence}]}。
subject/object 用 entities 的 id；无法定位证据时 evidence_id 必须为 null。
<TEXT>{{TEXT}}</TEXT>`;

function version(template: string): string {
  return createHash('sha256').update(template).digest('hex').slice(0, 16);
}

function parseLooseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

const FactResultSchema = z.object({
  entities: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      etype: z.enum(['person', 'org', 'concept', 'place', 'project', 'artifact']),
      canonical: z.string().nullable().optional(),
    }),
  ),
  facts: z.array(
    z.object({
      id: z.string().min(1),
      subject: z.string().min(1),
      predicate: z.string().min(1),
      object: z.string().min(1),
      evidence_id: z.string().nullable().optional(),
      origin: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ),
});

/** 通用 LLM 客户端端口：task 决定层与预算归属，默认 generate_reply（T1.5）。 */
export function createHTTPLLMClient(
  db: DatabaseSync,
  task = 'generate_reply',
  config?: LLMConfig,
): LLMClient {
  return {
    complete: async (prompt, options) => {
      const result = await callTask(db, task, prompt, {
        promptVersion: version(`llm-client:${task}`),
        input: prompt,
        temperature: options?.temperature,
        maxTokens: options?.max_tokens,
        config,
      });
      return result.text;
    },
  };
}

/** 主题识别：evidence 的 source_id 与 quote 必须来自输入原文，否则整批拒绝。 */
export function createHTTPTopicExtractor(db: DatabaseSync, config?: LLMConfig): TopicExtractor {
  return {
    extract: async (input: ExtractWindow) => {
      const sourcesText = input.sources
        .map((s) => `<SOURCE id="${s.id}">\n${s.text}\n</SOURCE>`)
        .join('\n');
      const prompt = TOPIC_TEMPLATE.replace('{{SOURCES}}', sourcesText);
      const result = await callTask(db, 'extract_tags', prompt, {
        promptVersion: version(TOPIC_TEMPLATE),
        input,
        config,
      });
      const drafts = DraftSchema.array().parse(parseLooseJson(result.text));
      const byId = new Map(input.sources.map((s) => [s.id, s.text]));
      for (const draft of drafts) {
        for (const evidence of draft.evidence) {
          if (evidence.source_type !== 'chunk') {
            throw new Error(`主题识别只允许 chunk 证据，收到 ${evidence.source_type}`);
          }
          const original = byId.get(evidence.source_id);
          if (!original || !original.includes(evidence.quote)) {
            throw new Error(`证据不可定位：${evidence.source_id} / ${evidence.quote.slice(0, 40)}`);
          }
        }
      }
      return drafts;
    },
  };
}

/** 沉淀判定：输出契约强校验，判定保守性由 evaluateVerdict 保证。 */
export function createHTTPJudge(db: DatabaseSync, config?: LLMConfig): Distiller['judge'] {
  return async (input: DistillInput) => {
    const prompt = JUDGE_TEMPLATE.replace('{{QUESTION}}', input.question).replace('{{ANSWER}}', input.answer);
    const result = await callTask(db, 'distill_judge', prompt, {
      promptVersion: version(JUDGE_TEMPLATE),
      input,
      config,
    });
    return DistillVerdict.parse(parseLooseJson(result.text));
  };
}

/** 条目生成：quote 必须在 ANSWER 中，产物由 generateDistillDraft 强制 proposed。 */
export function createHTTPDistillGenerator(db: DatabaseSync, config?: LLMConfig): DistillGenerator {
  return {
    generate: async (input: DistillInput, verdict: DistillVerdictType) => {
      const runId = input.retrieval_run_id ?? 'distill-session';
      const prompt = WIKI_TEMPLATE.replace('{{QUESTION}}', input.question)
        .replace('{{ANSWER}}', input.answer)
        .replace('{{VERDICT}}', JSON.stringify(verdict))
        .replaceAll('{{RUN_ID}}', runId);
      const result = await callTask(db, 'compile_wiki', prompt, {
        promptVersion: version(WIKI_TEMPLATE),
        input: { input, verdict },
        config,
      });
      const draft = DraftSchema.parse(parseLooseJson(result.text));
      for (const evidence of draft.evidence) {
        if (evidence.source_id !== runId || !input.answer.includes(evidence.quote)) {
          throw new Error(`沉淀证据不可定位：${evidence.quote.slice(0, 40)}`);
        }
      }
      return draft;
    },
  };
}

/** 完整 Distiller：judge + draft 都走 HTTP 端口。 */
export function createHTTPDistiller(db: DatabaseSync, config?: LLMConfig): Distiller {
  const judge = createHTTPJudge(db, config);
  const generator = createHTTPDistillGenerator(db, config);
  return { judge, draft: generator.generate };
}

/** 实体/事实抽取：契约校验后落库由 extractKnowledge 负责（事实默认 proposed）。 */
export function createHTTPFactExtractor(db: DatabaseSync, config?: LLMConfig): FactExtractorPort {
  return {
    extract: async (text: string) => {
      const prompt = FACT_TEMPLATE.replace('{{TEXT}}', text);
      const result = await callTask(db, 'extract_entities', prompt, {
        promptVersion: version(FACT_TEMPLATE),
        input: text,
        config,
      });
      const parsed = FactResultSchema.parse(parseLooseJson(result.text));
      return {
        entities: parsed.entities as EntityInput[],
        facts: parsed.facts as FactInput[],
      };
    },
  };
}
