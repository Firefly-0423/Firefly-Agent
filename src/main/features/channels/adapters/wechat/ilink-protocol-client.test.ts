import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ILinkClient, MediaType, SessionExpiredError, fetchQrCode, pollQrStatus, type WireMessage } from "./ilink-protocol-client";

const fetchMock = vi.fn<typeof fetch>();
const creds = { botToken: "test-token", ilinkBotId: "bot@test", ilinkUserId: "owner", baseUrl: "https://ilink.example" };
const client = () => new ILinkClient(creds, { wechatUin: "fixed-uin" });
function respond(data: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data), { status }));
}
function request(index = 0) {
  const [url, init] = fetchMock.mock.calls[index];
  return { url, ...init, body: init?.body ? JSON.parse(String(init.body)) : undefined };
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("ILinkClient", () => {
  it("uses configured identity, endpoint, authentication and supplied UIN", async () => {
    respond({});
    const c = client();
    expect(c.botUserId()).toBe("bot@test");
    expect(await c.getUpdates("cursor")).toEqual({ messages: [], buf: "" });
    expect(request()).toMatchObject({ url: "https://ilink.example/ilink/bot/getupdates", method: "POST",
      headers: { "Content-Type": "application/json", AuthorizationType: "ilink_bot_token", Authorization: "Bearer test-token", "X-WECHAT-UIN": "fixed-uin" },
      body: { get_updates_buf: "cursor", base_info: { channel_version: "2.0.0" } },
    });
  });

  it("falls back to the public endpoint and generates a base64 decimal UIN", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    respond({ ret: 0 });
    await new ILinkClient({ ...creds, baseUrl: "" }).getUpdates();
    expect(request()).toMatchObject({ url: "https://ilinkai.weixin.qq.com/ilink/bot/getupdates",
      headers: { "X-WECHAT-UIN": Buffer.from("0").toString("base64") }, body: { get_updates_buf: "" } });
  });

  it("filters bot echoes and preserves incoming order, metadata and text-item order", async () => {
    const wire: WireMessage = { message_id: 0, from_user_id: "user", to_user_id: "bot", message_type: 1,
      context_token: "opaque", create_time_ms: 42,
      item_list: [{ type: 1, text_item: { text: "hello" } }, { type: 2, text_item: { text: "ignore" } },
        { type: 1 }, { type: 1, text_item: { text: "" } }, { type: 1, text_item: { text: "世界" } }] };
    const missing = { from_user_id: "other", to_user_id: "bot", message_type: 1, context_token: "next" };
    respond({ ret: 0, msgs: [wire, { ...wire, message_type: 2 }, missing], get_updates_buf: "next-cursor" });
    expect(await client().getUpdates()).toEqual({ buf: "next-cursor", messages: [
      { msgId: "0", fromUserId: "user", toUserId: "bot", msgType: 1, content: "hello世界", items: wire.item_list,
        contextToken: "opaque", createTimeMs: 42, raw: wire },
      { msgId: "", fromUserId: "other", toUserId: "bot", msgType: 1, content: "", items: [], contextToken: "next", raw: missing },
    ] });
  });

  it.each([[-14, "iLink session expired (ret=-14)"], [2, "iLink getupdates failed: ret=2 denied"], [3, "iLink getupdates failed: ret=3 "]])(
    "rejects polling error ret=%s", async (ret, message) => {
      respond({ ret, ...(ret === 2 ? { errmsg: "denied" } : {}) });
      const error = await client().getUpdates().catch(e => e);
      expect(error.message).toBe(message);
      expect(error).toBeInstanceOf(ret === -14 ? SessionExpiredError : Error);
    },
  );

  it("rejects pre-abort without a request", async () => {
    const ctrl = new AbortController(); ctrl.abort(new Error("cancelled"));
    await expect(client().getUpdates("", ctrl.signal)).rejects.toThrow(/^cancelled$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards cancellation and releases the polling timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const ctrl = new AbortController();
    const pending = client().getUpdates("", ctrl.signal);
    const rejected = expect(pending).rejects.toThrow(/^stopped$/);
    ctrl.abort(new Error("stopped"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a hung poll after 40 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = client().getUpdates();
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(request().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends text and arbitrary media in order, using fresh message IDs", async () => {
    respond({}); respond({ ret: 0 });
    const c = client();
    expect(await c.sendText("recipient", "hello", "context")).toEqual({ ok: true });
    const items = [{ type: 2 as const, image_item: { url: "media" } }, { type: 1 as const, text_item: { text: "caption" } }];
    expect(await c.sendMessage("recipient", items, "context")).toEqual({ ok: true });
    expect(request()).toMatchObject({ url: "https://ilink.example/ilink/bot/sendmessage", body: {
      msg: { from_user_id: "", to_user_id: "recipient", message_type: 2, message_state: 2, context_token: "context",
        item_list: [{ type: 1, text_item: { text: "hello" } }] }, base_info: { channel_version: "2.0.0" },
    } });
    expect(request(1).body.msg.item_list).toEqual(items);
    expect(request().body.msg.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(request().body.msg.client_id).not.toBe(request(1).body.msg.client_id);
  });

  it.each([{ ret: 2, errmsg: "denied" }, { ret: 2 }])("returns protocol send failures: %j", async data => {
    respond(data);
    expect(await client().sendText("u", "t", "c")).toEqual({ ok: false, error: "errmsg" in data ? "denied" : "ret=2" });
  });
  it("returns transport failures but rethrows session expiry on send", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await client().sendMessage("u", [], "c")).toEqual({ ok: false, error: "Error: offline" });
    respond({ ret: -14 });
    await expect(client().sendText("u", "t", "c")).rejects.toMatchObject({ name: "SessionExpiredError", message: "session expired on send" });
  });

  it("passes upload fields through and returns the full upload response", async () => {
    const req = { filekey: "key", media_type: MediaType.FILE, to_user_id: "u", rawsize: 0, rawfilemd5: "md5", filesize: 16, no_need_thumb: true, aeskey: "fake" };
    const result = { upload_param: "p", thumb_upload_param: "thumb", upload_full_url: "https://cdn.example" };
    respond(result);
    expect(await client().getUploadUrl(req)).toEqual(result);
    expect(request()).toMatchObject({ url: "https://ilink.example/ilink/bot/getuploadurl", body: { ...req, base_info: { channel_version: "2.0.0" } } });
  });
  it.each([[-14, "session expired on getuploadurl"], [4, "iLink getuploadurl failed: ret=4"], [5, "iLink getuploadurl failed: denied"]])(
    "throws upload error ret=%s", async (ret, message) => {
      respond({ ret, ...(ret === 5 ? { errmsg: "denied" } : {}) });
      await expect(client().getUploadUrl({ filekey: "k", media_type: MediaType.IMAGE, to_user_id: "u", rawsize: 1, rawfilemd5: "m", filesize: 16 })).rejects.toThrow(new RegExp(`^${message}$`));
    },
  );

  it("returns typing tickets only on explicit success and tolerates config errors", async () => {
    const c = client();
    respond({ ret: 0, typing_ticket: "ticket" });
    expect(await c.getConfig("u", "c")).toEqual({ typingTicket: "ticket" });
    expect(request().body).toEqual({ ilink_user_id: "u", context_token: "c" });
    respond({ ret: 0 }); expect(await c.getConfig("u", "c")).toEqual({ typingTicket: undefined });
    respond({ ret: 1 }); expect(await c.getConfig("u", "c")).toEqual({});
    fetchMock.mockRejectedValueOnce(new Error("offline")); expect(await c.getConfig("u", "c")).toEqual({});
  });
  it("sends default/start and stop typing status and propagates transport errors", async () => {
    respond({}); respond({});
    await client().sendTyping("u", "ticket"); await client().sendTyping("u", "ticket", 2);
    expect(request().body).toEqual({ ilink_user_id: "u", typing_ticket: "ticket", status: 1 });
    expect(request(1).body.status).toBe(2);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(client().sendTyping("u", "t")).rejects.toThrow(/^offline$/);
  });
  it.each([false, true])("reports bounded HTTP/JSON errors (HTTP=%s)", async httpError => {
    const text = "x".repeat(220);
    fetchMock.mockResolvedValueOnce(new Response(text, { status: httpError ? 503 : 200 }));
    await expect(client().sendTyping("u", "t")).rejects.toThrow(new Error(httpError
      ? `HTTP 503 POST /ilink/bot/sendtyping: ${text.slice(0, 200)}`
      : `Non-JSON response from POST /ilink/bot/sendtyping: ${text.slice(0, 200)}`));
  });
});

describe("anonymous QR login", () => {
  it("fetches a QR code with anonymous UIN headers", async () => {
    respond({ qrcode: "qr", qrcode_img_content: "png" });
    expect(await fetchQrCode()).toEqual({ qrcode: "qr", qrcode_img_content: "png" });
    expect(request().url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3");
    expect(Object.keys(request().headers!)).toEqual(["X-WECHAT-UIN"]);
  });
  it("encodes QR content and forwards the caller signal", async () => {
    respond({ status: "confirmed", bot_token: "fake" });
    const signal = new AbortController().signal;
    expect(await pollQrStatus("a&?/ 空", signal)).toEqual({ status: "confirmed", bot_token: "fake" });
    expect(request()).toMatchObject({ url: `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent("a&?/ 空")}`, signal });
  });
  it.each([fetchQrCode, () => pollQrStatus("qr")])("bounds HTTP failure details", async login => {
    const text = "x".repeat(250);
    fetchMock.mockResolvedValueOnce(new Response(text, { status: 502 }));
    await expect(login()).rejects.toThrow(new Error(`${login === fetchQrCode ? "qrcode fetch" : "qrcode status"} failed: 502 ${text.slice(0, 200)}`));
  });
  it.each([fetchQrCode, () => pollQrStatus("qr")])("rejects malformed QR JSON", async login => {
    fetchMock.mockResolvedValueOnce(new Response("invalid"));
    await expect(login()).rejects.toBeInstanceOf(SyntaxError);
  });
});
