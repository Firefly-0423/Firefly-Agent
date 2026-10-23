import WebSocket from "ws";

export const QQBOT_INTENT_GROUP_AND_C2C = 1 << 25;
export type QqBotEventType = "C2C_MESSAGE_CREATE" | "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE" | "READY" | "RESUMED";
export type QqBotWsEvents = {
  onError: (error: Error) => void;
  onReadyChange: (ready: boolean) => void;
  onDispatch: (type: QqBotEventType, data: Record<string, unknown>) => void;
};
export interface QqBotWsClientOptions extends QqBotWsEvents {
  websocketFactory?: (url: string) => WebSocket;
  maxBackoffMs?: number;
  intents?: number;
  getAccessToken: () => Promise<string>;
  gatewayUrl: string;
}
type WsPayload = { d?: unknown; t?: string; s?: number; op?: number };

export class QqBotWsClient {
  private connection: WebSocket | null = null;
  private pulse: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private identify: ReturnType<typeof setTimeout> | null = null;
  private halted = false;
  private epoch = 0;
  private sequence = 0;
  private session = "";
  private authenticated = false;
  private retryDelay = 1_000;
  private acknowledged = true;
  private failure: Error | null = null;
  constructor(private readonly options: QqBotWsClientOptions) {}

  get isReady(): boolean { return this.authenticated; }
  getLastError(): Error | null { return this.failure; }
  async start(): Promise<void> {
    this.halted = false;
    this.epoch++;
    await this.connect(false);
  }
  async stop(): Promise<void> {
    this.halted = true;
    this.epoch++;
    this.clearTimers();
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.readyState <= WebSocket.OPEN) {
      connection.removeAllListeners();
      try { connection.close(1000, "client shutdown"); }
      catch { /* 停止操作允许连接已断开。 */ }
    }
    this.setReady(false);
  }
  private setReady(value: boolean): void {
    if (this.authenticated === value) return;
    this.authenticated = value;
    this.options.onReadyChange(value);
  }
  private async connect(resume: boolean): Promise<void> {
    if (this.halted) return;
    const epoch = this.epoch;
    let credential: string;
    try { credential = await this.options.getAccessToken(); }
    catch (failure) {
      if (this.halted || epoch !== this.epoch) return;
      const diagnostic = failure instanceof Error ? failure : new Error(String(failure));
      this.failure = diagnostic;
      this.options.onError(diagnostic);
      this.scheduleReconnect();
      return;
    }
    if (this.halted || epoch !== this.epoch) return;
    const connection = this.options.websocketFactory ? this.options.websocketFactory(this.options.gatewayUrl) : new WebSocket(this.options.gatewayUrl);
    this.connection = connection;
    this.acknowledged = true;
    connection.on("message", (bytes: unknown) => {
      try { this.handlePayload(JSON.parse(String(bytes)) as WsPayload, credential, resume); }
      catch (failure) { this.options.onError(failure instanceof Error ? failure : new Error(String(failure))); }
    });
    connection.on("error", (failure: Error) => { this.failure = failure; this.options.onError(failure); });
    connection.on("close", () => {
      this.clearHeartbeat();
      if (this.halted) return;
      this.setReady(false);
      this.scheduleReconnect();
    });
  }
  private handlePayload(frame: WsPayload, credential: string, resume: boolean): void {
    if (frame.op === 10) {
      const period = Number((frame.d as { heartbeat_interval?: number } | null)?.heartbeat_interval ?? 30_000);
      this.startHeartbeat(period);
      if (resume && this.session && this.sequence > 0) {
        this.send({ op: 6, d: { token: `QQBot ${credential}`, session_id: this.session, seq: this.sequence } });
      } else this.sendIdentify(credential);
      return;
    }
    if (frame.op === 0) {
      if (typeof frame.s === "number") this.sequence = frame.s;
      const event = (frame.t ?? "") as QqBotEventType;
      const body = (frame.d ?? {}) as Record<string, unknown>;
      if (event === "READY") {
        this.session = String(body.session_id ?? "");
        this.retryDelay = 1_000;
        this.setReady(true);
      } else if (event === "RESUMED") {
        this.retryDelay = 1_000;
        this.setReady(true);
      } else this.options.onDispatch(event, body);
      return;
    }
    if (frame.op === 11) { this.acknowledged = true; return; }
    if (frame.op === 7) {
      this.setReady(false);
      if (this.connection) {
        try { this.connection.close(4000, "server requested reconnect"); }
        catch { /* 后续 close 事件负责重连。 */ }
      }
      return;
    }
    if (frame.op !== 9) return;
    this.setReady(false);
    this.session = "";
    this.sequence = 0;
    if (this.identify) clearTimeout(this.identify);
    const connection = this.connection;
    const epoch = this.epoch;
    this.identify = setTimeout(() => {
      this.identify = null;
      if (!this.halted && epoch === this.epoch && this.connection === connection) this.sendIdentify(credential);
    }, 3_000);
  }
  private sendIdentify(credential: string): void {
    this.send({ op: 2, d: {
      token: `QQBot ${credential}`, intents: this.options.intents ?? QQBOT_INTENT_GROUP_AND_C2C,
      shard: [0, 1], properties: { $os: process.platform, $browser: "firefly", $device: "firefly" },
    } });
  }
  private startHeartbeat(period: number): void {
    this.clearHeartbeat();
    this.acknowledged = true;
    this.pulse = setInterval(() => {
      if (!this.acknowledged) {
        this.options.onError(new Error("QQ Bot 心跳超时，重连"));
        try { this.connection?.terminate(); }
        catch { /* 已经关闭的连接无需再次终止。 */ }
        return;
      }
      this.acknowledged = false;
      this.send({ op: 1, d: this.sequence > 0 ? this.sequence : null });
    }, Math.max(1_000, period));
  }
  private send(frame: WsPayload): void {
    const connection = this.connection;
    if (!connection || connection.readyState !== WebSocket.OPEN) return;
    try { connection.send(JSON.stringify(frame)); }
    catch (failure) { this.options.onError(failure instanceof Error ? failure : new Error(String(failure))); }
  }
  private scheduleReconnect(): void {
    if (this.halted || this.reconnect) return;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.options.maxBackoffMs ?? 60_000);
    const resumable = Boolean(this.session) && this.sequence > 0;
    this.reconnect = setTimeout(() => { this.reconnect = null; void this.connect(resumable); }, wait);
  }
  private clearHeartbeat(): void {
    if (this.pulse) { clearInterval(this.pulse); this.pulse = null; }
  }
  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.identify) { clearTimeout(this.identify); this.identify = null; }
    if (this.reconnect) { clearTimeout(this.reconnect); this.reconnect = null; }
  }
}
