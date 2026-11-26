import type { DatabaseSync } from '../sqlite.js';
import { lintStructure } from './lint.js';

export type MetricId = 'M15' | 'M16' | 'M17' | 'M18' | 'M19' | 'M20';

export interface MetricResult {
  id: MetricId;
  name: string;
  value: number | null;
  unit: string;
  target: string;
  hard_gate: boolean;
  measured: boolean;
  detail: string;
}

/** 口径固定来自 10 §3 / §6D；阈值先于实现确定，代码只负责算 */
export const METRIC_DEFS: Record<MetricId, Omit<MetricResult, 'value' | 'measured' | 'detail'>> = {
  M15: { id: 'M15', name: '沉淀采纳率', unit: 'ratio', target: '60–70%', hard_gate: false },
  M16: { id: 'M16', name: 'wiki 命中率', unit: 'ratio', target: '≥30%', hard_gate: false },
  M17: { id: 'M17', name: '导航准确率', unit: 'ratio', target: '≥60%（P2）', hard_gate: false },
  M18: { id: 'M18', name: '失效链接率', unit: 'ratio', target: '<5%', hard_gate: true },
  M19: { id: 'M19', name: 'wiki-source 事实一致率', unit: 'ratio', target: '≥90%', hard_gate: true },
  M20: { id: 'M20', name: '编译延迟 P95', unit: 'ms', target: '≤60000ms', hard_gate: false },
};

export interface MetricInputs {
  now?: number;
  distillation?: { confirmed: number; generated: number } | null;
  retrieval?: { wiki_hits: number; total: number } | null;
  navigation?: { correct: number; total: number } | null;
  consistency?: { checked: number; inconsistent: number } | null;
  compile_latencies_ms?: number[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function result(id: MetricId, value: number | null, detail: string): MetricResult {
  const def = METRIC_DEFS[id];
  return { ...def, value, measured: value !== null, detail };
}

/**
 * M15–M20 计算骨架：公式真实，缺数据源返回 null + 原因（不伪造达标）。
 * M18 可从当前库直接统计；其余需运行日志/抽检/金标集输入。
 */
export function computeMetrics(db: DatabaseSync, inputs: MetricInputs = {}): MetricResult[] {
  const lint = lintStructure(db, inputs.now ?? Date.now());
  const m15 = ratio(inputs.distillation?.confirmed ?? 0, inputs.distillation?.generated ?? 0);
  const m16 = ratio(inputs.retrieval?.wiki_hits ?? 0, inputs.retrieval?.total ?? 0);
  const m17 = ratio(inputs.navigation?.correct ?? 0, inputs.navigation?.total ?? 0);
  const m18 = ratio(lint.stale_stubs, lint.total_links);
  const m19 = inputs.consistency
    ? ratio(
        inputs.consistency.checked - inputs.consistency.inconsistent,
        inputs.consistency.checked,
      )
    : null;
  const m20 = p95(inputs.compile_latencies_ms ?? []);

  return [
    result('M15', m15, m15 === null ? '缺沉淀建议确认日志，未测量' : '全量建议确认记录'),
    result('M16', m16, m16 === null ? '缺检索命中埋点，未测量' : '全量检索埋点'),
    result('M17', m17, m17 === null ? '缺金标集导航结果（10 例结构已备），未测量' : '编译层 10 例金标集'),
    result('M18', m18, m18 === null ? '无链接样本，不用小样本下结论' : lint.detail),
    result('M19', m19, m19 === null ? '缺每周 30 页抽检结果，未测量' : '事实一致性抽检'),
    result('M20', m20, m20 === null ? '缺编译完成时间埋点，未测量' : '编译延迟 P95'),
  ];
}
