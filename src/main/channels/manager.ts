import type { ChannelAdapter } from "./adapters/base";
import type { ChannelId, ChannelStatus, IncomingMessage, OutgoingMessage } from "./types";
import { setAdapterHandler } from "./adapters/base";
import { logger, LogTag } from "../logger";
import { createChannelMemoryIngressIssuer, type ChannelMemoryIngress } from "../memory-context/channel-memory-ingress";

export type DispatchFn = (msg: IncomingMessage, ingress?: ChannelMemoryIngress) => Promise<OutgoingMessage | null>;
export class ChannelManager {
  private registered = new Map<ChannelId, ChannelAdapter>();
  private dispatch: DispatchFn | null = null;
  private running = new Set<ChannelId>();
  #lifetimes = new Map<ChannelId, AbortController>();
  #issuer = createChannelMemoryIngressIssuer({ isCurrent: (adapter, signal) => this.registered.get(adapter.id) === adapter
    && this.#lifetimes.get(adapter.id)?.signal === signal && !signal.aborted });
  private revokeMemory(id: ChannelId): void {
    const lifetime = this.#lifetimes.get(id);
    this.#lifetimes.delete(id);
    lifetime?.abort(Error("MEMORY_CHANNEL_INGRESS_DENIED"));
  }
  private beginMemory(id: ChannelId): void { this.revokeMemory(id); this.#lifetimes.set(id, new AbortController()); }
  has(id: ChannelId): boolean { return this.registered.has(id); }
  register(adapter: ChannelAdapter): void {
    if (this.registered.has(adapter.id)) throw new Error(`渠道 ${adapter.id} 已注册，禁止覆盖现有实例`);
    this.registered.set(adapter.id, adapter);
  }
  setDispatcher(fn: DispatchFn): void {
    this.dispatch = fn;
    for (const adapter of this.registered.values()) setAdapterHandler(adapter, this.#makeAdapterHandler(adapter.id));
  }
  async startAll(): Promise<void> {
    for (const adapter of this.registered.values()) {
      if (this.running.has(adapter.id)) continue;
      try {
        this.beginMemory(adapter.id);
        if (this.dispatch) setAdapterHandler(adapter, this.#makeAdapterHandler(adapter.id));
        await adapter.start();
        this.running.add(adapter.id);
        logger.info(LogTag.Channels, `started: ${adapter.id} (${adapter.displayName})`);
      } catch (failure) {
        this.revokeMemory(adapter.id);
        console.error("[ChannelManager]", `渠道启动失败 [${adapter.id}]:`, failure instanceof Error ? failure.message : failure);
      }
    }
  }
  async unregister(id: ChannelId): Promise<boolean> {
    const adapter = this.registered.get(id);
    if (!adapter) return false;
    this.revokeMemory(id);
    if (this.running.has(id)) {
      try { await adapter.stop(); }
      catch (failure) { console.warn("[ChannelManager]", `渠道停止失败 [${id}]:`, failure instanceof Error ? failure.message : failure); }
      this.running.delete(id);
    }
    this.registered.delete(id);
    logger.info(LogTag.Channels, `unregistered: ${id}`);
    return true;
  }
  async startOne(id: ChannelId): Promise<void> {
    const adapter = this.registered.get(id);
    if (!adapter) return;
    if (this.running.has(id)) return;
    this.beginMemory(id);
    if (this.dispatch) setAdapterHandler(adapter, this.#makeAdapterHandler(id));
    try { await adapter.start(); }
    catch (failure) { this.revokeMemory(id); throw failure; }
    this.running.add(id);
    logger.info(LogTag.Channels, `started: ${id} (${adapter.displayName})`);
  }
  async stopAll(): Promise<void> {
    for (const id of this.#lifetimes.keys()) this.revokeMemory(id);
    for (const id of this.running) {
      const adapter = this.registered.get(id);
      if (!adapter) continue;
      try { await adapter.stop(); }
      catch (failure) { console.warn("[ChannelManager]", `渠道停止失败 [${id}]:`, failure instanceof Error ? failure.message : failure); }
    }
    this.running.clear();
  }
  getAdapter(channel: ChannelId): ChannelAdapter | undefined { return this.registered.get(channel); }
  listChannels(): ChannelId[] { return Array.from(this.registered.keys()); }
  getAllStatus(): Record<ChannelId, ChannelStatus> {
    const statuses: Partial<Record<ChannelId, ChannelStatus>> = {};
    for (const [id, adapter] of this.registered.entries()) statuses[id] = adapter.getStatus();
    return statuses as Record<ChannelId, ChannelStatus>;
  }
  #makeAdapterHandler(channel: ChannelId) {
    const adapter = this.registered.get(channel);
    const signal = this.#lifetimes.get(channel)?.signal;
    return async (msg: IncomingMessage): Promise<OutgoingMessage | null> => {
      if (!this.dispatch) { console.warn("[ChannelManager]", `收到入站消息但 dispatcher 未注册 [${channel}]`); return null; }
      try {
        const authority = adapter && signal ? this.#issuer.capture(adapter, msg, signal) : undefined;
        return await this.dispatch(msg, authority);
      } catch (failure) { console.error("[ChannelManager]", `dispatcher 处理失败 [${channel}]:`, failure); return null; }
    };
  }
}
export const channelManager = new ChannelManager();
