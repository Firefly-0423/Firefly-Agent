// channels/sender-approval —— 设置页对待批准发送者的批准/忽略处理，以及状态里的待批准列表。
import {
  isSenderGatedChannel,
  isValidSenderId,
  type PendingSender,
  type PendingSenderRegistry,
  type SenderGatedChannel,
} from "./sender-gate";
import type { ChannelsSettings } from "./settings-store";
import type { ChannelStatus } from "./types";

export type SenderResolveAction = "approve" | "dismiss";

export interface SenderResolveDeps {
  registry: PendingSenderRegistry;
  load(): ChannelsSettings;
  save(patch: { [K in SenderGatedChannel]?: { allowedSenderIds: string[] } }): unknown;
}

export type SenderResolveResult = { ok: true } | { ok: false; error: string };

export function resolvePendingSender(payload: unknown, deps: SenderResolveDeps): SenderResolveResult {
  const input = (payload ?? {}) as { channel?: unknown; senderId?: unknown; action?: unknown };
  if (!isSenderGatedChannel(input.channel)) return { ok: false, error: "不支持的渠道" };
  if (!isValidSenderId(input.senderId)) return { ok: false, error: "发送者标识无效" };
  if (input.action !== "approve" && input.action !== "dismiss") return { ok: false, error: "不支持的操作" };
  const { channel, senderId } = input;

  // 只处理确实在待批准列表里的发送者，避免用任意 id 直接写白名单。
  if (!deps.registry.list(channel).some((item) => item.senderId === senderId)) {
    return { ok: false, error: "该发送者不在待批准列表中" };
  }
  if (input.action === "approve") {
    const current = deps.load()[channel].allowedSenderIds;
    if (!current.includes(senderId)) deps.save({ [channel]: { allowedSenderIds: [...current, senderId] } });
  }
  deps.registry.remove(channel, senderId);
  return { ok: true };
}

/** 把待批准列表并入渠道状态，供设置页展示。 */
export function withPendingSenders(
  status: Record<string, ChannelStatus>,
  registry: PendingSenderRegistry,
): Record<string, ChannelStatus> {
  const out: Record<string, ChannelStatus> = { ...status };
  for (const channel of ["wechat", "feishu"] as const) {
    const current = out[channel];
    if (!current) continue;
    const pending: PendingSender[] = registry.list(channel);
    out[channel] = { ...current, detail: { ...current.detail, pendingSenders: pending } };
  }
  return out;
}
