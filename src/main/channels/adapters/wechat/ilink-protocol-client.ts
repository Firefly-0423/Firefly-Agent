import { randomUUID } from "node:crypto";

const BASE_URL = "https://ilinkai.weixin.qq.com";
export type ItemType = 1 | 2 | 3 | 4 | 5;
export type MessageType = 1;
export enum MediaType { IMAGE = 1, VIDEO = 2, FILE = 3, VOICE = 4 }
export type Credentials = { accountId?: string; ilinkUserId: string; baseUrl: string; ilinkBotId: string; botToken: string };
export type WeixinMessage = {
  raw: unknown; createTimeMs?: number; contextToken: string; items: WeixinItem[];
  content: string; msgType: number; toUserId: string; fromUserId: string; msgId: string;
};
export type WeixinItem = { video_item?: any; file_item?: any; voice_item?: any; image_item?: any; text_item?: { text: string }; type: ItemType };
export type WireMessage = {
  [k: string]: unknown;
  item_list: WeixinItem[]; create_time_ms?: number; context_token: string; message_state?: number;
  message_type: number; to_user_id: string; from_user_id: string; message_id?: number;
};
type GetUpdatesResponse = { longpolling_timeout_ms?: number; get_updates_buf?: string; msgs?: WireMessage[]; errmsg?: string; errcode?: number; ret: number };
export type CDNMedia = { full_url?: string; encrypt_type?: 0 | 1; aes_key: string; encrypt_query_param: string };
export type SendMessageItem = { video_item?: any; file_item?: any; voice_item?: any; image_item?: any; text_item?: { text: string }; type: ItemType };
export type GetUploadUrlRequest = {
  aeskey?: string; no_need_thumb?: boolean; thumb_filesize?: number; thumb_rawfilemd5?: string; thumb_rawsize?: number;
  filesize: number; rawfilemd5: string; rawsize: number; to_user_id: string; media_type: MediaType; filekey: string;
};
export type GetUploadUrlResponse = { upload_full_url?: string; thumb_upload_param?: string; upload_param: string };
export type ILinkClientOptions = { wechatUin?: string };
export type QrCodeResp = { qrcode_img_content: string; qrcode: string };
export type QrStatusResp = { ilink_user_id?: string; baseurl?: string; ilink_bot_id?: string; bot_token?: string; status: "init" | "scanned" | "confirmed" | "expired" | string };

function randomWechatUin(): string {
  const integer = (Math.random() * 0xffffffff) >>> 0;
  return Buffer.from(String(integer), "utf8").toString("base64");
}
export class SessionExpiredError extends Error {
  constructor(msg: string) { super(msg); this.name = "SessionExpiredError"; }
}

export class ILinkClient {
  private endpoint: string;
  private credential: string;
  private identity: string;
  private uin: string;
  constructor(creds: Credentials, opts: ILinkClientOptions = {}) {
    this.endpoint = creds.baseUrl || BASE_URL;
    this.credential = creds.botToken;
    this.identity = creds.ilinkBotId;
    this.uin = opts.wechatUin ?? randomWechatUin();
  }
  botUserId(): string { return this.identity; }
  async getUpdates(buf = "", signal?: AbortSignal): Promise<{ messages: WeixinMessage[]; buf: string }> {
    signal?.throwIfAborted();
    const cancellation = new AbortController();
    const forwardCancellation = () => cancellation.abort(signal?.reason);
    signal?.addEventListener("abort", forwardCancellation, { once: true });
    const deadline = setTimeout(() => cancellation.abort(), 35_000 + 5_000);
    try {
      const received = await this.doJson<unknown>("POST", "/ilink/bot/getupdates", { get_updates_buf: buf, base_info: { channel_version: "2.0.0" } }, { signal: cancellation.signal });
      const payload = received as GetUpdatesResponse;
      if (payload.ret === -14) throw new SessionExpiredError("iLink session expired (ret=-14)");
      if (payload.ret !== undefined && payload.ret !== 0) throw new Error(`iLink getupdates failed: ret=${payload.ret} ${payload.errmsg ?? ""}`);
      const inbound = (payload.msgs ?? []).filter((wire) => wire.message_type === 1);
      return { messages: inbound.map((wire) => this.#wireToMessage(wire)), buf: payload.get_updates_buf ?? "" };
    } finally {
      signal?.removeEventListener("abort", forwardCancellation);
      clearTimeout(deadline);
    }
  }
  #wireToMessage(wire: WireMessage): WeixinMessage {
    const words = (wire.item_list ?? []).filter((fragment) => fragment.type === 1 && fragment.text_item?.text)
      .map((fragment) => fragment.text_item!.text).join("");
    return {
      msgId: String(wire.message_id ?? ""), fromUserId: wire.from_user_id, toUserId: wire.to_user_id,
      msgType: wire.message_type, content: words, items: wire.item_list ?? [], contextToken: wire.context_token,
      createTimeMs: wire.create_time_ms, raw: wire,
    };
  }
  async sendText(toUserId: string, text: string, contextToken: string): Promise<{ ok: boolean; error?: string }> {
    const fragments: SendMessageItem[] = [{ type: 1, text_item: { text } }];
    return this.sendMessage(toUserId, fragments, contextToken);
  }
  async sendMessage(toUserId: string, itemList: SendMessageItem[], contextToken: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const received = await this.doJson<unknown>("POST", "/ilink/bot/sendmessage", {
        msg: { from_user_id: "", to_user_id: toUserId, client_id: randomUUID(), message_type: 2,
          message_state: 2, context_token: contextToken, item_list: itemList },
        base_info: { channel_version: "2.0.0" },
      });
      const acknowledgement = received as { ret?: number; errmsg?: string };
      if (acknowledgement.ret === -14) throw new SessionExpiredError("session expired on send");
      if (acknowledgement.ret !== 0 && acknowledgement.ret !== undefined) return { ok: false, error: acknowledgement.errmsg ?? `ret=${acknowledgement.ret}` };
      return { ok: true };
    } catch (failure) {
      if (failure instanceof SessionExpiredError) throw failure;
      return { ok: false, error: String(failure) };
    }
  }
  async getUploadUrl(req: GetUploadUrlRequest): Promise<GetUploadUrlResponse> {
    const received = await this.doJson<unknown>("POST", "/ilink/bot/getuploadurl", { ...req, base_info: { channel_version: "2.0.0" } });
    const ticket = received as GetUploadUrlResponse & { ret?: number; errmsg?: string };
    if (ticket.ret === -14) throw new SessionExpiredError("session expired on getuploadurl");
    if (ticket.ret !== 0 && ticket.ret !== undefined) throw new Error(`iLink getuploadurl failed: ${ticket.errmsg ?? `ret=${ticket.ret}`}`);
    return ticket;
  }
  async getConfig(userId: string, contextToken: string): Promise<{ typingTicket?: string }> {
    try {
      const received = await this.doJson<unknown>("POST", "/ilink/bot/getconfig", { ilink_user_id: userId, context_token: contextToken });
      const config = received as { ret?: number; typing_ticket?: string; errmsg?: string };
      return config.ret === 0 ? { typingTicket: config.typing_ticket } : {};
    } catch { return {}; }
  }
  async sendTyping(userId: string, typingTicket: string, status: 1 | 2 = 1): Promise<void> {
    await this.doJson<unknown>("POST", "/ilink/bot/sendtyping", { ilink_user_id: userId, typing_ticket: typingTicket, status });
  }
  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", "AuthorizationType": "ilink_bot_token", "Authorization": `Bearer ${this.credential}`, "X-WECHAT-UIN": this.uin };
  }
  private async doJson<T>(method: string, route: string, payload: unknown, init?: RequestInit): Promise<T> {
    const received = await fetch(this.endpoint + route, { method, headers: this.headers(), body: JSON.stringify(payload), ...init });
    const body = await received.text();
    if (!received.ok) throw new Error(`HTTP ${received.status} ${method} ${route}: ${body.slice(0, 200)}`);
    try { return JSON.parse(body) as T; }
    catch { throw new Error(`Non-JSON response from ${method} ${route}: ${body.slice(0, 200)}`); }
  }
}

export async function fetchQrCode(): Promise<QrCodeResp> {
  const uin = randomWechatUin();
  const address = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const received = await fetch(address, { headers: { "X-WECHAT-UIN": uin } });
  const body = await received.text();
  if (!received.ok) throw new Error(`qrcode fetch failed: ${received.status} ${body.slice(0, 200)}`);
  return JSON.parse(body) as QrCodeResp;
}
export async function pollQrStatus(qrcode: string, signal?: AbortSignal): Promise<QrStatusResp> {
  const uin = randomWechatUin();
  const address = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const received = await fetch(address, { headers: { "X-WECHAT-UIN": uin }, signal });
  const body = await received.text();
  if (!received.ok) throw new Error(`qrcode status failed: ${received.status} ${body.slice(0, 200)}`);
  return JSON.parse(body) as QrStatusResp;
}
