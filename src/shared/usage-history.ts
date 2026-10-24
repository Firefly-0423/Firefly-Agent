// 用量历史的数据形状：主进程 token-usage-store 产出，设置窗口的用量页消费。

export interface UsageHistoryDay {
  date: string;
  weekday: string;
  /** 输入 + 输出。 */
  tokens: number;
  requests: number;
  /** 当天各模型的 token；旧数据没有模型维度时整天记在"未归类"。 */
  byModel: Record<string, number>;
  /** 当天各功能的 token；记录功能维度之前的用量不在其中。 */
  byFeature: Record<string, number>;
  messages: number;
  skillCalls: number;
  pluginCalls: number;
}

export interface UsageHistory {
  days: UsageHistoryDay[];
  /** 区间内按用量降序的模型 / 功能合计。 */
  models: Array<{ name: string; tokens: number; requests: number }>;
  features: Array<{ name: string; tokens: number; requests: number }>;
  /** 区间内用量最大的会话（含所属功能），最多 10 个。 */
  sessions: Array<{ id: string; feature: string; tokens: number; requests: number }>;
  skills: Array<{ id: string; count: number }>;
  plugins: Array<{ id: string; count: number }>;
}

/** 一个会话累计的运行统计，显示在输入框下方的"会话统计"里。 */
export interface SessionStats {
  /** 用户消息触发的运行次数。 */
  rounds: number;
  /** 模型请求 + 工具调用的总步数。 */
  steps: number;
  modelMs: number;
  toolMs: number;
  /** 首 token 平均耗时；没有流式请求时为 null。 */
  avgTtftMs: number | null;
  /** 输出速度（tok/s）；没有流式输出时为 null。 */
  tokensPerSecond: number | null;
}

/** IPC 返回给界面的形状：会话排行带上标题，已删除或临时的会话为 null。 */
export type UsageHistoryView = Omit<UsageHistory, "sessions"> & {
  sessions: Array<UsageHistory["sessions"][number] & { title: string | null }>;
};
