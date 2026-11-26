import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from '../sqlite.js';
import { canonical, loadConfig, priceFor, resolveModel } from './config.js';
import type { LLMConfig } from './config.js';
import { BudgetExceededError, LLMCallError, ModelUnavailableError } from './errors.js';
import { resolveRoute } from './routing.js';
import type { ModelLayer } from './routing.js';

type FetchImpl = typeof globalThis.fetch;

export interface CallOptions {
  /** prompt 模板版本 = 内容哈希（08 §7.2），由调用方计算 */
  promptVersion: string;
  /** 用于缓存键与输入哈希的规范化输入；缺省为 prompt 原文 */
  input?: unknown;
  traceId?: string;
  temperature?: number;
  maxTokens?: number;
  config?: LLMConfig;
  fetchImpl?: FetchImpl;
}

export interface CallResult {
  text: string;
  cached: boolean;
  model: string;
  provider: string;
  layer: ModelLayer;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** usage 缺失时按 05 §4.1 估算，必须标记 */
  estimated: boolean;
  latencyMs: number;
  taskId: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** 05 §4.1 兜底估算：ceil(utf8_bytes / 3) */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function classifyHttp(status: number, message: string): LLMCallError {
  if (status === 429) return new LLMCallError('RATE_LIMIT', message, true);
  if (status >= 500) return new LLMCallError('UPSTREAM_5XX', message, true);
  return new LLMCallError(`HTTP_${status}`, message, false);
}

interface TaskRecord {
  id: string;
  layer: ModelLayer;
  provider: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  costUsd: number;
  latencyMs: number | null;
  status: 'ok' | 'error' | 'timeout' | 'blocked';
  errorCode: string | null;
  traceId: string | null;
}

function recordTask(db: DatabaseSync, record: TaskRecord): void {
  db.prepare(
    `INSERT INTO llm_tasks
       (id, layer, provider, model, prompt_version, input_hash, input_tokens, output_tokens,
        cached, cost_usd, latency_ms, status, error_code, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.layer,
    record.provider,
    record.model,
    record.promptVersion,
    record.inputHash,
    record.inputTokens,
    record.outputTokens,
    record.cached ? 1 : 0,
    record.costUsd,
    record.latencyMs,
    record.status,
    record.errorCode,
    record.traceId,
    Date.now(),
  );
}

/**
 * 真实模型调用骨架：HTTP 外呼、记账、缓存与预算闸门都是真逻辑；
 * 模型身份/价格由仓库外注入，未启用时拒绝外呼（08 §1/§4/§7）。
 */
export async function callTask(
  db: DatabaseSync,
  task: string,
  prompt: string,
  options: CallOptions,
): Promise<CallResult> {
  const route = resolveRoute(task);
  const config = options.config ?? loadConfig();
  if (!config.enabled) throw new ModelUnavailableError('CONGNI_LLM_ENABLED 未启用');

  // T0 与规则任务不经过云端网关（08 §1）
  if (route.layer === null || route.layer === 'T0') {
    throw new ModelUnavailableError(`任务 ${task} 属于 ${route.layer ?? '规则'}，不走云端网关`);
  }

  const model = resolveModel(config, route.layer);
  if (!config.baseUrl) throw new ModelUnavailableError('CONGNI_LLM_BASE_URL 未配置');

  const inputHash = sha256(`${model}|${options.promptVersion}|${canonical(options.input ?? prompt)}`);
  const taskId = randomUUID();
  const traceId = options.traceId ?? null;
  const common = {
    id: taskId,
    layer: route.layer,
    provider: config.provider,
    model,
    promptVersion: options.promptVersion,
    inputHash,
    traceId,
  };

  // 缓存命中：成本 0，仍写 llm_tasks（08 §6.2）
  if (route.cacheable) {
    const hit = db
      .prepare('SELECT output_json FROM llm_cache WHERE input_hash = ?')
      .get(inputHash) as { output_json: string } | undefined;
    if (hit) {
      db.prepare('UPDATE llm_cache SET hit_count = hit_count + 1 WHERE input_hash = ?').run(inputHash);
      const cached = JSON.parse(hit.output_json) as Pick<CallResult, 'text' | 'inputTokens' | 'outputTokens'>;
      recordTask(db, { ...common, ...cached, cached: true, costUsd: 0, latencyMs: 0, status: 'ok', errorCode: null });
      return {
        ...cached,
        cached: true,
        model,
        provider: config.provider,
        layer: route.layer,
        costUsd: 0,
        estimated: false,
        latencyMs: 0,
        taskId,
      };
    }
  }

  const estimatedInput = estimateTokens(prompt);
  const price = priceFor(config, config.provider, model);
  const estimateCost = (estimatedInput * price.input_per_mtok) / 1_000_000;

  // 预算闸门：monthly_usd=0 表示只记账不拦截（08 §4.1）
  if (config.monthlyUsd > 0) {
    const used = (
      db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_tasks WHERE created_at >= ?').get(monthStart(Date.now())) as {
        total: number;
      }
    ).total;
    if (used + estimateCost > config.monthlyUsd) {
      recordTask(db, {
        ...common,
        inputTokens: estimatedInput,
        outputTokens: 0,
        cached: false,
        costUsd: 0,
        latencyMs: null,
        status: 'blocked',
        errorCode: 'BUDGET_EXCEEDED',
      });
      throw new BudgetExceededError(`月累计 ${used.toFixed(4)} + 预估 ${estimateCost.toFixed(4)} > ${config.monthlyUsd}`);
    }
  }
  if (config.perTurnUsd > 0 && estimateCost > config.perTurnUsd) {
    recordTask(db, {
      ...common,
      inputTokens: estimatedInput,
      outputTokens: 0,
      cached: false,
      costUsd: 0,
      latencyMs: null,
      status: 'blocked',
      errorCode: 'BUDGET_EXCEEDED',
    });
    throw new BudgetExceededError(`单轮预估 ${estimateCost.toFixed(4)} > ${config.perTurnUsd}`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.min(route.timeoutMs, config.timeoutMs);
  const startedAt = Date.now();
  let lastError: LLMCallError | null = null;
  let responseText: string | null = null;
  let usage: ChatCompletionResponse['usage'] | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options.maxTokens ?? route.maxTokens,
          temperature: options.temperature ?? 0,
          stream: false,
        }),
      });
      const body = (await response.json()) as ChatCompletionResponse;
      if (!response.ok) {
        throw classifyHttp(response.status, body.error?.message ?? `HTTP ${response.status}`);
      }
      responseText = body.choices?.[0]?.message?.content ?? null;
      if (responseText === null) throw new LLMCallError('EMPTY_CHOICE', '响应无 choices[0].message.content', false);
      usage = body.usage;
      break;
    } catch (error) {
      if (error instanceof LLMCallError) {
        lastError = error;
      } else if (error instanceof Error && error.name === 'AbortError') {
        lastError = new LLMCallError('TIMEOUT', `超过 ${timeoutMs}ms`, true);
      } else {
        lastError = new LLMCallError('NETWORK', error instanceof Error ? error.message : String(error), true);
      }
      if (!lastError.retryable || attempt === config.maxRetries) break;
    } finally {
      clearTimeout(timer);
    }
  }

  const latencyMs = Date.now() - startedAt;
  if (lastError && responseText === null) {
    const status = lastError.code === 'TIMEOUT' ? 'timeout' : 'error';
    recordTask(db, {
      ...common,
      inputTokens: estimatedInput,
      outputTokens: 0,
      cached: false,
      costUsd: 0,
      latencyMs,
      status,
      errorCode: lastError.code,
    });
    throw lastError;
  }

  const inputTokens = usage?.prompt_tokens ?? estimatedInput;
  const outputTokens = usage?.completion_tokens ?? estimateTokens(responseText ?? '');
  const estimated = usage?.prompt_tokens === undefined || usage?.completion_tokens === undefined;
  const costUsd = (inputTokens * price.input_per_mtok + outputTokens * price.output_per_mtok) / 1_000_000;
  const text = responseText ?? '';

  recordTask(db, {
    ...common,
    inputTokens,
    outputTokens,
    cached: false,
    costUsd,
    latencyMs,
    status: 'ok',
    errorCode: null,
  });

  if (route.cacheable) {
    db.prepare(
      `INSERT OR REPLACE INTO llm_cache
         (input_hash, layer, model, prompt_version, output_json, hit_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      inputHash,
      route.layer,
      model,
      options.promptVersion,
      JSON.stringify({ text, inputTokens, outputTokens }),
      Date.now(),
    );
  }

  return {
    text,
    cached: false,
    model,
    provider: config.provider,
    layer: route.layer,
    inputTokens,
    outputTokens,
    costUsd,
    estimated,
    latencyMs,
    taskId,
  };
}
