import type { MetricResult } from './metrics.js';

export interface GateResult {
  id: string;
  ok: boolean;
  measured: boolean;
  detail: string;
}

/**
 * 10 §6D.1 闸门骨架。未测量一律 ok=false（fail-closed）；
 * "未测量"与"已测量且违规"分开：后者才触发冻结回滚，前者只是不能前进。
 */
export function evaluateGates(metrics: MetricResult[]): GateResult[] {
  const get = (id: string): MetricResult | undefined => metrics.find((metric) => metric.id === id);
  const check = (
    id: string,
    predicate: (value: number) => boolean,
    expected: string,
  ): GateResult => {
    const metric = get(id);
    if (!metric || !metric.measured || metric.value === null) {
      return { id, ok: false, measured: false, detail: `${expected}；当前未测量，闸门不通过` };
    }
    const ok = predicate(metric.value);
    return { id, ok, measured: true, detail: `${expected}；实测 ${metric.value.toFixed(4)}` };
  };

  return [
    check('M15', (v) => v >= 0.6 && v <= 0.7, '60–70%'),
    check('M16', (v) => v >= 0.3, '≥30%'),
    check('M17', (v) => v >= 0.6, '≥60%（P2）'),
    check('M18', (v) => v < 0.05, '<5%'),
    check('M19', (v) => v >= 0.9, '≥90%'),
    check('M20', (v) => v <= 60_000, '≤60000ms'),
  ];
}

export interface HardGateState {
  violated: boolean;
  unmeasured: boolean;
  freeze: boolean;
}

/** 冻结条件仅由 M18/M19 已测量且违规触发（10 §6D.3）；未测量不冒充违规 */
export function hardGateState(metrics: MetricResult[]): HardGateState {
  const m18 = metrics.find((metric) => metric.id === 'M18');
  const m19 = metrics.find((metric) => metric.id === 'M19');
  const violated =
    (m18?.measured === true && m18.value !== null && m18.value >= 0.05) ||
    (m19?.measured === true && m19.value !== null && m19.value < 0.9);
  const unmeasured = m18?.measured !== true || m19?.measured !== true;
  return { violated, unmeasured, freeze: violated };
}
