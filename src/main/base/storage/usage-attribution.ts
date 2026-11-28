// 用量归因：把一次模型请求记到"哪个功能、哪个会话"名下。
//
// 模型请求散落在聊天循环、Harness、压缩、记忆、插件等多处，没有一处同时知道功能和会话。
// 这里用 AsyncLocalStorage 在运行入口声明一次归因，其后同一异步链上的 recordUsage / recordRequest 自动读取，
// 不需要逐层传参；入口之外发生的请求归入 "other"。

import { AsyncLocalStorage } from "node:async_hooks";

/** 用量统计里的功能分类；顺序即界面图例的顺序。 */
export const USAGE_FEATURES = ["chat", "work", "code", "subagent", "plugin", "memory", "proactive", "other"] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

export interface UsageAttribution {
  feature: UsageFeature;
  /** 会话 id；没有会话的后台请求（记忆、主动聊天）为空。 */
  sessionId?: string;
  /** 插件 id；仅 feature 为 "plugin" 时有值。 */
  pluginId?: string;
  /** 本次运行已派出的子代理数；工具执行前后对比它，就知道这个工具是不是在代为运行子代理（其耗时已记在子代理的请求里）。 */
  delegations?: number;
}

const storage = new AsyncLocalStorage<UsageAttribution>();

/** 在 fn 的整条异步链上声明归因；嵌套时内层整体替换外层。 */
export function runWithUsageAttribution<T>(attribution: UsageAttribution, fn: () => T): T {
  return storage.run(attribution, fn);
}

export function currentUsageAttribution(): UsageAttribution | undefined {
  return storage.getStore();
}

/** 子代理沿用父运行的会话，只把功能改成 subagent。 */
export function runAsSubagent<T>(fn: () => T): T {
  const parent = storage.getStore();
  if (parent) parent.delegations = (parent.delegations ?? 0) + 1;
  return storage.run({ feature: "subagent", sessionId: parent?.sessionId }, fn);
}

/** 会话模式 → 功能分类；未知模式（如 learn）按 work 计。 */
export function usageFeatureForMode(mode: unknown): UsageFeature {
  return mode === "chat" || mode === "code" ? mode : "work";
}

export function isUsageFeature(value: unknown): value is UsageFeature {
  return typeof value === "string" && (USAGE_FEATURES as readonly string[]).includes(value);
}
