/** 模型接入的可分类失败。错误码同时写入 llm_tasks.error_code（08 §3.2）。 */
export class UnknownTaskError extends Error {
  readonly code = 'UNKNOWN_TASK';
  constructor(task: string) {
    super(`未登记的任务不允许调用模型：${task}`);
    this.name = 'UnknownTaskError';
  }
}

export class ModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE';
  constructor(reason: string) {
    super(`模型通道不可用：${reason}`);
    this.name = 'ModelUnavailableError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(reason: string) {
    super(`预算闸门拦截：${reason}`);
    this.name = 'BudgetExceededError';
  }
}

export class LLMCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'LLMCallError';
    this.code = code;
    this.retryable = retryable;
  }
}
