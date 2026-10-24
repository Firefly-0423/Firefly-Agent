// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const timeoutUserChoiceInput = control<HTMLInputElement>("timeout-user-choice");
export const timeoutUserChoiceReset = control<HTMLButtonElement>("timeout-user-choice-reset-btn");
export const timeoutTestInput = control<HTMLInputElement>("timeout-test");
export const timeoutTestReset = control<HTMLButtonElement>("timeout-test-reset-btn");
export const maxParallelToolCallsInput = control<HTMLInputElement>("max-parallel-tool-calls");
export const maxToolRoundsInput = control<HTMLInputElement>("max-tool-rounds");
export const runTimeoutMinutesInput = control<HTMLInputElement>("run-timeout-minutes");
