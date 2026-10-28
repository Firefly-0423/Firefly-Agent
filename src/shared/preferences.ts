export type ProactiveChatMode = "on" | "off";
export type ProactiveDeliveryTarget = "local" | "wechat" | "feishu";

export const normalizeChatSocialContextEnabled = (value: unknown): boolean => value === true;

/** Chat-mode replies shown as several bubbles; on unless turned off. */
export const normalizeSegmentedChatEnabled = (value: unknown): boolean => value !== false;

export const normalizeProactiveChatMode = (value: unknown): ProactiveChatMode =>
  value === "on" ? "on" : "off";

export function normalizeProactiveDeliveryTarget(value: unknown): ProactiveDeliveryTarget {
  if (value === "wechat" || value === "feishu") return value;
  return "local";
}
