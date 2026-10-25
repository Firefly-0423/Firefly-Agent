import * as http from "http";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { loadChannelsSettings, saveChannelsSettings } from "./settings-store";
import { channelManager } from "./manager";
import type { ChannelId, IncomingMessage } from "./types";
import { logger, LogTag } from "../logging/logger";

export type NormalizeFn = (channel: ChannelId, raw: unknown) => IncomingMessage | null;
export interface InboundServerHandle { close(): Promise<void>; port: number; }
const handlers: Array<{ channel: ChannelId; normalize: NormalizeFn }> = [];
let listener: http.Server | null = null;
let handle: InboundServerHandle | null = null;
export function registerInboundRoute(channel: ChannelId, normalize: NormalizeFn): void {
  const position = handlers.findIndex((entry) => entry.channel === channel);
  if (position >= 0) handlers[position] = { channel, normalize };
  else handlers.push({ channel, normalize });
}
function checkSecret(request: http.IncomingMessage, secret: string): boolean {
  if (!secret) return true;
  const supplied = request.headers["x-firefly-channel-secret"];
  if (typeof supplied !== "string") return false;
  const wanted = Buffer.from(secret, "utf8");
  const received = Buffer.from(supplied, "utf8");
  if (wanted.length !== received.length) return false;
  return timingSafeEqual(wanted, received);
}
function readBody(request: http.IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((accept, fail) => {
    let received = 0;
    const buffers: Buffer[] = [];
    request.on("data", (bytes: Buffer) => {
      received += bytes.length;
      if (received > max) { fail(new Error("payload too large")); request.destroy(); return; }
      buffers.push(bytes);
    });
    request.on("end", () => accept(Buffer.concat(buffers).toString("utf8")));
    request.on("error", fail);
  });
}
function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse, secret: string): Promise<void> {
  if (request.url === "/channels/healthz" && request.method === "GET") {
    sendJson(response, 200, { ok: true, channels: channelManager.listChannels() });
    return;
  }
  const match = /^\/channels\/([^/]+)\/inbound\/?$/.exec(request.url || "");
  if (!match || request.method !== "POST") { sendJson(response, 404, { ok: false, error: "not found" }); return; }
  const channel = decodeURIComponent(match[1]) as ChannelId;
  if (!checkSecret(request, secret)) { sendJson(response, 401, { ok: false, error: "invalid shared secret" }); return; }
  const route = handlers.find((entry) => entry.channel === channel);
  if (!route) { sendJson(response, 404, { ok: false, error: `no route registered for channel: ${channel}` }); return; }
  let payload: unknown = null;
  try { const body = await readBody(request); payload = body ? JSON.parse(body) : null; }
  catch (failure) { sendJson(response, 400, { ok: false, error: failure instanceof Error ? failure.message : "bad json" }); return; }
  let incoming: IncomingMessage | null = null;
  try { incoming = route.normalize(channel, payload); }
  catch (failure) {
    console.error("[InboundServer]", `normalize 失败 [${channel}]:`, failure);
    sendJson(response, 500, { ok: false, error: "normalize failed" }); return;
  }
  if (!incoming) { sendJson(response, 200, { ok: true, ignored: true }); return; }
  const adapter = channelManager.getAdapter(channel);
  if (!adapter || !adapter.onMessage) { sendJson(response, 503, { ok: false, error: "adapter not ready" }); return; }
  try {
    const outgoing = await adapter.onMessage(incoming);
    sendJson(response, 200, { ok: true, replied: outgoing != null });
  } catch (failure) {
    console.error("[InboundServer]", `handler 失败 [${channel}]:`, failure);
    sendJson(response, 500, { ok: false, error: "handler failed" });
  }
}
export async function startInboundServer(): Promise<InboundServerHandle> {
  const settings = loadChannelsSettings();
  let secret = settings.sharedSecret;
  if (!secret) { secret = randomBytes(32).toString("hex"); saveChannelsSettings({ sharedSecret: secret }); }
  if (handle && listener) return handle;
  const candidates: Array<number | "random"> = [];
  if (settings.inboundPort > 0) candidates.push(settings.inboundPort);
  candidates.push("random");
  let failure: unknown = null;
  let boundPort = 0;
  for (const candidate of candidates) {
    if (listener) {
      try { await new Promise<void>((accept) => listener!.close(() => accept())); }
      catch { /* 失败实例可能尚未进入监听状态。 */ }
      listener = null;
    }
    const requested = candidate === "random" ? 0 : candidate;
    listener = http.createServer((request, response) => {
      handleRequest(request, response, secret).catch((failure) => {
        console.error("[InboundServer]", "unhandled:", failure);
        try { sendJson(response, 500, { ok: false, error: "internal" }); }
        catch { /* 对端可能已经关闭连接。 */ }
      });
    });
    try {
      await new Promise<void>((accept, fail) => {
        const failed = (failure: Error) => fail(failure);
        listener!.once("error", failed);
        listener!.listen(requested, "127.0.0.1", () => { listener!.off("error", failed); accept(); });
      });
      const address = listener.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      break;
    } catch (error) {
      failure = error;
      logger.warn(LogTag.InboundServer, `port ${requested === 0 ? "(random)" : requested} in use, trying next`);
      continue;
    }
  }
  if (!listener || boundPort === 0) throw failure instanceof Error ? failure : new Error("inbound-server 启动失败");
  const port = boundPort;
  if (settings.inboundPort !== port) saveChannelsSettings({ inboundPort: port });
  handle = { port, close: () => new Promise<void>((accept) => {
    if (listener) listener.close(() => { listener = null; handle = null; accept(); });
    else accept();
  }) };
  logger.info(LogTag.InboundServer, `listening on http://127.0.0.1:${port}`);
  return handle;
}
export async function stopInboundServer(): Promise<void> { if (handle) await handle.close(); }
export function signPayload(payload: string, secret: string): string { return createHmac("sha256", secret).update(payload).digest("hex"); }
