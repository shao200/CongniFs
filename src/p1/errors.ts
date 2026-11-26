/**
 * P1 立骨专用：明确标记"结构已就位、逻辑未实现"。
 * 任何骨架默认入口都必须抛这个错误，避免被调用方误当成已完成能力。
 */
export class NotImplementedError extends Error {
  readonly phase = 'P1' as const;

  constructor(what: string) {
    super(`[P1 骨架] ${what} 尚未实现`);
    this.name = 'NotImplementedError';
  }
}
