export type TimeoutSettings = {
  modelRequestTimeoutSec?: number;
  profileMinimumRemainingBudgetMs: number;
  testTimeout: number;
  userChoiceTimeout: number;
  chatRequestTimeout: number;
};
export const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 300000;
export const DEFAULT_TIMEOUT_SETTINGS: TimeoutSettings = {
  testTimeout: 15000, chatRequestTimeout: DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
  userChoiceTimeout: 60000, profileMinimumRemainingBudgetMs: -1,
};
