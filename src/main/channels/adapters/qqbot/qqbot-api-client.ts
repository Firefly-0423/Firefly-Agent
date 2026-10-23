export type QqBotTokenProviderConfig = { clientSecret: string; appId: string };
export type QqBotFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type QqBotSendTarget = { chatType: "private" | "group"; openid: string };
export type QqBotSendOptions = { msgSeq: number; msgId: string };

export class QqBotApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: unknown) {
    super(message);
    this.name = "QqBotApiError";
  }
}
export class QqBotApiClient {
  private credential = "";
  private expires = 0;
  private refreshing: Promise<string> | null = null;
  constructor(private readonly config: QqBotTokenProviderConfig, private readonly fetchFn: QqBotFetch = (url, init) => fetch(url, init)) {}

  async getAccessToken(): Promise<string> {
    const instant = Date.now();
    if (this.credential && instant < this.expires - 5 * 60_000) return this.credential;
    this.refreshing ??= this.refreshToken().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async getGatewayUrl(): Promise<string> {
    const gateway = await this.request<{ url?: string }>("/gateway");
    if (!gateway.url) throw new QqBotApiError("gateway 响应缺少 url", 200);
    return gateway.url;
  }
  async sendText(target: QqBotSendTarget, content: string, options: QqBotSendOptions): Promise<void> {
    const endpoint = target.chatType === "group" ? `/v2/groups/${encodeURIComponent(target.openid)}/messages` : `/v2/users/${encodeURIComponent(target.openid)}/messages`;
    await this.request(endpoint, { method: "POST", body: JSON.stringify({ msg_type: 0, content, msg_id: options.msgId, msg_seq: options.msgSeq }) });
  }
  private async refreshToken(): Promise<string> {
    const received = await this.fetchFn("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.clientSecret }),
    });
    if (!received.ok) throw new QqBotApiError(`获取 access_token 失败 (HTTP ${received.status})`, received.status);
    const payload = await received.json() as { access_token?: string; expires_in?: string | number };
    if (!payload.access_token) throw new QqBotApiError("access_token 响应缺少 access_token", 200);
    const seconds = Number(payload.expires_in ?? 7200);
    this.credential = payload.access_token;
    this.expires = Date.now() + (Number.isFinite(seconds) ? seconds : 7200) * 1000;
    return this.credential;
  }
  private async request<T>(endpoint: string, init?: RequestInit): Promise<T> {
    const credential = await this.getAccessToken();
    const received = await this.fetchFn(`https://api.sgroup.qq.com${endpoint}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${credential}`, ...(init?.headers ?? {}) },
    });
    if (!received.ok) {
      let explanation = "";
      try {
        const payload = await received.json() as { code?: unknown; message?: unknown };
        explanation = payload.message ? ` ${String(payload.message)} (code ${String(payload.code)})` : "";
      } catch { /* 响应可能没有 JSON 错误体。 */ }
      throw new QqBotApiError(`QQ Bot API ${endpoint} 失败 (HTTP ${received.status})${explanation}`, received.status);
    }
    const body = await received.text();
    return (body ? JSON.parse(body) : {}) as T;
  }
}
