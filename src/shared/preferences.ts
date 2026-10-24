export type SegmentedOutputMode = "all" | "chat" | "off";
export type ProactiveChatMode = "on" | "off";
export type ProactiveDeliveryTarget = "local" | "wechat" | "feishu";

export const normalizeChatSocialContextEnabled = (value: unknown): boolean => value === true;

export function normalizeSegmentedOutputMode(value: unknown): SegmentedOutputMode {
  if (value === "all" || value === "chat") return value;
  return "off";
}

export const normalizeProactiveChatMode = (value: unknown): ProactiveChatMode =>
  value === "on" ? "on" : "off";

export function normalizeProactiveDeliveryTarget(value: unknown): ProactiveDeliveryTarget {
  if (value === "wechat" || value === "feishu") return value;
  return "local";
}
