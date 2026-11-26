import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { computeMetrics } from '../src/p1/metrics.js';
import { evaluateGates, hardGateState } from '../src/p1/gates.js';

/**
 * P1 编译层评测骨架（10 §6D）：金标集结构校验 + M15–M20 公式输出。
 * 缺数据源的指标返回未测量；闸门对未测量 fail-closed，不产出达标结论。
 */
const path = new URL('../tests/fixtures/p1-golden-10.json', import.meta.url);
const golden = JSON.parse(readFileSync(path, 'utf8')) as {
  version: string;
  phase: string;
  cases: Array<{ id: string; question: string; status: string }>;
};

const invalid = golden.cases.filter(
  (item) => !item.id || !item.question || !['pending', 'ready'].includes(item.status),
);
if (invalid.length > 0) {
  console.error(`金标集结构异常：${invalid.length} 例`);
  process.exitCode = 1;
} else {
  const db = openDb(':memory:');
  const metrics = computeMetrics(db);
  const gates = evaluateGates(metrics);
  const hard = hardGateState(metrics);
  db.close();
  console.log(
    JSON.stringify(
      {
        version: golden.version,
        phase: golden.phase,
        cases: golden.cases.length,
        ready: golden.cases.filter((item) => item.status === 'ready').length,
        metrics,
        gates,
        hard_gate_state: hard,
        note: '公式与闸门已定义；无运行数据的指标未测量，闸门不通过',
      },
      null,
      2,
    ),
  );
}
