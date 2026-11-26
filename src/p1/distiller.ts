import { DistillVerdict, WikiPageDraft } from '../contracts.js';
import { DistillInput } from './contracts.js';
import type { Distiller } from './contracts.js';
import { NotImplementedError } from './errors.js';

/**
 * 沉淀判定骨架（05 §6C.2）：判定规则可测，判定与生成本身需接 LLM。
 * 保守判定：should_save 且命中信号 ≥2，才允许生成草稿。
 */
export function evaluateVerdict(verdict: DistillVerdict): boolean {
  return verdict.should_save && verdict.signals.length >= 2;
}

export const stubDistiller: Distiller = {
  judge: () => Promise.reject(new NotImplementedError('distiller.judge（保守判定需接 LLM）')),
  draft: () => Promise.reject(new NotImplementedError('distiller.draft（条目生成需接 LLM）')),
};

export async function distill(input: DistillInput, distiller: Distiller = stubDistiller): Promise<WikiPageDraft | null> {
  const parsedInput = DistillInput.parse(input);
  const rawVerdict = await distiller.judge(parsedInput);
  const verdict = DistillVerdict.parse(rawVerdict);
  if (!evaluateVerdict(verdict)) return null;

  const draft = await distiller.draft(parsedInput, verdict);
  if (!draft) return null;

  // I18：沉淀路径强制 proposed；没有 evidence 的草稿由契约直接拒绝
  return WikiPageDraft.parse({
    ...draft,
    status: 'proposed',
    created_by: 'system',
    updated_by: null,
  });
}
