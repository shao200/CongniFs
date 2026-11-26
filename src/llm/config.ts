import type { ModelLayer } from './routing.js';
import { ModelUnavailableError } from './errors.js';

/**
 * 模型身份与价格只在配置中存在（08 §1/§5.1）。
 * 本文件不得出现任何具体模型名或单价——仓库外注入是硬约束。
 */
export interface Price {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface LLMConfig {
  enabled: boolean;
  provider: string;
  baseUrl: string | null;
  apiKey: string | null;
  /** 层 → 模型名；值全部来自仓库外 */
  models: Partial<Record<ModelLayer, string>>;
  /** provider:model → 价格；缺失视为 0（只记账不拦截） */
  pricing: Record<string, Price>;
  timeoutMs: number;
  maxRetries: number;
  /** 0 = 未设置预算，只记账不拦截（08 §4.1 D7 未拍板） */
  monthlyUsd: number;
  perTurnUsd: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** 从环境变量读取配置；未设置 enabled 时默认关闭，绝不外呼。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  let pricing: Record<string, Price> = {};
  const rawPricing = env.CONGNI_LLM_PRICING;
  if (rawPricing) {
    try {
      const parsed: unknown = JSON.parse(rawPricing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        pricing = parsed as Record<string, Price>;
      }
    } catch {
      // 计价配置无效时退化为 0 计价，不能因此拦截调用
      pricing = {};
    }
  }

  const models: Partial<Record<ModelLayer, string>> = {};
  const t1 = env.CONGNI_LLM_MODEL_T1;
  const t15 = env.CONGNI_LLM_MODEL_T15;
  const t2 = env.CONGNI_LLM_MODEL_T2;
  if (t1) models.T1 = t1;
  if (t15) models['T1.5'] = t15;
  if (t2) models.T2 = t2;

  return {
    enabled: bool(env.CONGNI_LLM_ENABLED),
    provider: env.CONGNI_LLM_PROVIDER ?? 'openai-compatible',
    baseUrl: env.CONGNI_LLM_BASE_URL ?? null,
    apiKey: env.CONGNI_LLM_API_KEY ?? null,
    models,
    pricing,
    timeoutMs: num(env.CONGNI_LLM_TIMEOUT_MS, 30_000),
    maxRetries: Math.min(3, Math.floor(num(env.CONGNI_LLM_MAX_RETRIES, 1))),
    monthlyUsd: num(env.CONGNI_LLM_BUDGET_MONTHLY_USD, 0),
    perTurnUsd: num(env.CONGNI_LLM_PER_TURN_USD, 0),
  };
}

/** 取层的模型身份；未配置即不可用，不提供任何内置默认模型名。 */
export function resolveModel(config: LLMConfig, layer: ModelLayer): string {
  const model = config.models[layer];
  if (!model) {
    throw new ModelUnavailableError(`层 ${layer} 未配置模型（仓库外注入 CONGNI_LLM_MODEL_*）`);
  }
  return model;
}

/** 价格只查配置；未登记=0，不做内置价格表。 */
export function priceFor(config: LLMConfig, provider: string, model: string): Price {
  return config.pricing[`${provider}:${model}`] ?? { input_per_mtok: 0, output_per_mtok: 0 };
}

/** canonical(input)：稳定序列化，保证缓存键可复现（08 §6.1）。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
