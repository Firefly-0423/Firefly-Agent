// channels/sender-gate —— 微信、飞书的发送者放行判定与待批准登记。
//
// 陌生人第一次发来消息时不进入 Agent，只记入待批准列表；用户在设置页批准后，
// 该发送者才写入白名单。待批准列表只保存在内存里：重启后陌生人再发一条即可重新出现。
import type { ChannelId } from "./types";

/** 受发送者白名单约束的渠道。QQ、QQ 机器人各有自己的白名单。 */
export type SenderGatedChannel = Extract<ChannelId, "wechat" | "feishu">;

export interface SenderGateConfig {
  allowAnyPrivate: boolean;
  allowedSenderIds: string[];
}

export interface PendingSender {
  senderId: string;
  senderName?: string;
  /** 最近一次来信的毫秒时间戳。 */
  at: number;
}

const MAX_PENDING_PER_CHANNEL = 20;
const SENDER_ID_PATTERN = /^[A-Za-z0-9@._:=-]{1,128}$/;
const SENDER_NAME_MAX_LENGTH = 64;

/** 微信 iLink 用户 id（形如 xxx@im.wechat）与飞书 open_id（ou_…）共用的格式校验。 */
export function isValidSenderId(value: unknown): value is string {
  return typeof value === "string" && SENDER_ID_PATTERN.test(value);
}

export function normalizeSenderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => String(item).trim())
    .filter(isValidSenderId)));
}

export function isSenderAllowed(config: SenderGateConfig, senderId: string): boolean {
  return config.allowAnyPrivate === true || config.allowedSenderIds?.includes(senderId) === true;
}

type Listener = (channel: SenderGatedChannel) => void;

/** 同一渠道两次"新增陌生人"通知之间的最短间隔；窗口内的变化合并为窗口结束时的一次通知。 */
const RECORD_NOTIFY_INTERVAL_MS = 500;

export class PendingSenderRegistry {
  private readonly pending = new Map<SenderGatedChannel, Map<string, PendingSender>>();
  private readonly listeners = new Set<Listener>();
  private readonly cooldown = new Map<SenderGatedChannel, { timer: NodeJS.Timeout; dirty: boolean }>();

  /**
   * 记录一次被拒的来信。同一发送者只保留一条并刷新时间；重复来信不通知界面，
   * 只有新增发送者或昵称变化才通知，且按渠道限频，陌生人无法借此刷出无限的状态广播。
   */
  record(channel: SenderGatedChannel, senderId: string, senderName?: string, at = Date.now()): void {
    if (!isValidSenderId(senderId)) return;
    const bucket = this.pending.get(channel) ?? new Map<string, PendingSender>();
    this.pending.set(channel, bucket);
    const name = senderName?.trim().slice(0, SENDER_NAME_MAX_LENGTH) || undefined;
    const previous = bucket.get(senderId);
    const changed = !previous || previous.senderName !== name;
    bucket.delete(senderId);
    bucket.set(senderId, { senderId, senderName: name, at });
    while (bucket.size > MAX_PENDING_PER_CHANNEL) {
      bucket.delete(bucket.keys().next().value!);
    }
    if (changed) this.notifyThrottled(channel);
  }

  list(channel: SenderGatedChannel): PendingSender[] {
    return Array.from(this.pending.get(channel)?.values() ?? []).sort((a, b) => b.at - a.at);
  }

  remove(channel: SenderGatedChannel, senderId: string): boolean {
    const removed = this.pending.get(channel)?.delete(senderId) ?? false;
    if (removed) this.emit(channel);
    return removed;
  }

  clear(): void {
    this.pending.clear();
    for (const { timer } of this.cooldown.values()) clearTimeout(timer);
    this.cooldown.clear();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyThrottled(channel: SenderGatedChannel): void {
    const active = this.cooldown.get(channel);
    if (active) {
      active.dirty = true;
      return;
    }
    this.emit(channel);
    const state = { dirty: false, timer: undefined as unknown as NodeJS.Timeout };
    state.timer = setTimeout(() => {
      this.cooldown.delete(channel);
      if (state.dirty) this.notifyThrottled(channel);
    }, RECORD_NOTIFY_INTERVAL_MS);
    state.timer.unref?.();
    this.cooldown.set(channel, state);
  }

  private emit(channel: SenderGatedChannel): void {
    for (const listener of this.listeners) {
      try {
        listener(channel);
      } catch (err) {
        console.warn("[SenderGate] 监听器失败:", err);
      }
    }
  }
}

export const pendingSenders = new PendingSenderRegistry();

export function isSenderGatedChannel(value: unknown): value is SenderGatedChannel {
  return value === "wechat" || value === "feishu";
}

/**
 * 入站放行判定。拒绝时登记到待批准列表；读取设置失败（config 为 null）一律按拒绝处理。
 */
export function admitSender(
  channel: SenderGatedChannel,
  config: SenderGateConfig | null,
  senderId: string,
  senderName?: string,
): boolean {
  if (config && isSenderAllowed(config, senderId)) return true;
  pendingSenders.record(channel, senderId, senderName);
  return false;
}
