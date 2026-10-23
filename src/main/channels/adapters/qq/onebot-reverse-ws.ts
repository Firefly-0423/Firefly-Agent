import * as http from "node:http";
import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { OneBotActionClient } from "./onebot-action-client";
import type { OneBotEvent } from "./onebot-types";
import type { QqListenMode } from "../../settings-store";
import { normalizeQqListenMode, type QqListenAuthRequirement } from "../../../../shared/qq-listen";

export const ONEBOT_WS_PATH = "/onebot/v11/ws";
export type OneBotReverseWsOptions = {
  onError?: (error: Error) => void;
  onClientDisconnected?: (reason?: string) => void;
  onClientConnected: (client: OneBotActionClient, info: { headerSelfId?: string; remoteAddress?: string }) => void | Promise<void>;
  onEvent: (event: OneBotEvent, client: OneBotActionClient) => void | Promise<void>;
  heartbeatTimeoutMs?: number; path?: string; accessToken?: string; port: number; customHost?: string; listenMode: QqListenMode;
};
export type OneBotListeningInfo = { mode: QqListenMode; url: string; path: string; port: number; host: string };
export function resolveOneBotListenHost(mode: QqListenMode, customHost?: string, interfaces?: ReturnType<typeof networkInterfaces>): { host: string; resolvedMode: QqListenMode } {
  if (mode === "loopback") return { host: "127.0.0.1", resolvedMode: "loopback" };
  if (mode === "custom") {
    const address = customHost?.trim();
    if (!address) throw new Error("QQ 自定义监听地址为空");
    return { host: address, resolvedMode: "custom" };
  }
  const discovered = Object.entries(interfaces ?? networkInterfaces()).filter(([label]) => /wsl/i.test(label))
    .flatMap(([, records]) => records ?? []).find((record) => record.family === "IPv4" && !record.internal)?.address;
  if (discovered) return { host: discovered, resolvedMode: "wsl" };
  if (mode === "wsl") throw new Error("未检测到 Windows WSL 虚拟网卡 IPv4 地址");
  return { host: "127.0.0.1", resolvedMode: "loopback" };
}
export function isLoopbackHost(host: string): boolean {
  const address = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return address === "" || address === "127.0.0.1" || address === "localhost" || address === "::1" || address === "::ffff:127.0.0.1";
}
export function resolveQqListenAuthRequirement(input: { listenMode?: unknown; customHost?: unknown }, interfaces: Parameters<typeof resolveOneBotListenHost>[2] = undefined): QqListenAuthRequirement {
  const custom = typeof input.customHost === "string" ? input.customHost : undefined;
  try {
    const resolved = resolveOneBotListenHost(normalizeQqListenMode(input.listenMode), custom, interfaces);
    return { ok: true, requiresAccessToken: !isLoopbackHost(resolved.host), resolvedHost: resolved.host, resolvedMode: resolved.resolvedMode };
  } catch (failure) { return { ok: false, requiresAccessToken: false, error: failure instanceof Error ? failure.message : String(failure) }; }
}
function tokenMatches(authorization: string | undefined, token: string): boolean {
  if (!token) return true;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const expected = Buffer.from(token, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class OneBotReverseWsServer {
  private listener: http.Server | null = null;
  private gateway: WebSocketServer | null = null;
  private peer: WebSocket | null = null;
  private actions: OneBotActionClient | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private accountHeader: string | undefined;
  private bound: OneBotListeningInfo | null = null;
  constructor(private readonly options: OneBotReverseWsOptions) {}
  get client(): OneBotActionClient | null { return this.actions; }
  get info(): OneBotListeningInfo | null { return this.bound; }

  private acceptPeer(connection: WebSocket, request: http.IncomingMessage): void {
    const claimed = Array.isArray(request.headers["x-self-id"]) ? request.headers["x-self-id"][0] : request.headers["x-self-id"];
    if (!claimed) { connection.close(4002, "X-Self-ID is required"); return; }
    if (this.peer && this.peer.readyState === 1) {
      if (this.accountHeader && claimed && this.accountHeader !== claimed) { connection.close(4003, "another QQ account is already connected"); return; }
      this.peer.close(4001, "replaced by reconnect");
    }
    const actions = new OneBotActionClient(connection);
    this.peer = connection;
    this.actions = actions;
    this.accountHeader = claimed;
    this.lastActivity = Date.now();
    connection.on("message", (bytes) => {
      this.lastActivity = Date.now();
      let payload: unknown;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { return; }
      if (actions.handleResponse(payload)) return;
      void Promise.resolve(this.options.onEvent(payload as OneBotEvent, actions)).catch((failure) => {
        this.options.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
      });
    });
    connection.once("close", (_code, reason) => {
      actions.rejectAll();
      if (this.peer !== connection) return;
      this.peer = null;
      this.actions = null;
      this.accountHeader = undefined;
      this.options.onClientDisconnected?.(reason.toString("utf8") || undefined);
    });
    connection.on("error", (failure) => this.options.onError?.(failure));
    void Promise.resolve(this.options.onClientConnected(actions, { headerSelfId: claimed, remoteAddress: request.socket.remoteAddress })).catch((failure) => {
      this.options.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
      connection.close(1011, "OneBot handshake failed");
    });
  }
  async start(): Promise<OneBotListeningInfo> {
    if (this.listener) return this.bound!;
    const resolved = resolveOneBotListenHost(this.options.listenMode, this.options.customHost);
    const address = resolved.host;
    const token = this.options.accessToken?.trim() ?? "";
    if (!isLoopbackHost(address) && !token) throw new Error(`QQ 监听非回环地址 ${address} 时必须配置 Access Token（该网络上任意进程都可冒充 NapCat 注入消息）`);
    const endpoint = this.options.path ?? ONEBOT_WS_PATH;
    const listener = http.createServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    const gateway = new WebSocketServer({ noServer: true, maxPayload: 110 * 1024 * 1024 });
    gateway.on("error", (failure) => this.options.onError?.(failure));
    listener.on("upgrade", (request, connection, bytes) => {
      const requested = new URL(request.url ?? "/", "http://localhost").pathname;
      if (requested !== endpoint) { connection.write("HTTP/1.1 404 Not Found\r\n\r\n"); connection.destroy(); return; }
      if (!tokenMatches(request.headers.authorization, token)) { connection.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); connection.destroy(); return; }
      gateway.handleUpgrade(request, connection, bytes, (upgraded) => gateway.emit("connection", upgraded, request));
    });
    gateway.on("connection", (connection, request) => this.acceptPeer(connection, request));
    try {
      await new Promise<void>((accept, fail) => {
        const failed = (failure: Error) => fail(failure);
        listener.once("error", failed);
        listener.listen(this.options.port, address, () => { listener.off("error", failed); accept(); });
      });
    } catch (failure) { gateway.close(); listener.close(); throw failure; }
    this.listener = listener;
    this.gateway = gateway;
    const display = address.includes(":") ? `[${address}]` : address;
    const binding = listener.address();
    const port = typeof binding === "object" && binding ? binding.port : this.options.port;
    this.bound = { host: address, port, path: endpoint, url: `ws://${display}:${port}${endpoint}`, mode: resolved.resolvedMode };
    const timeout = this.options.heartbeatTimeoutMs ?? 90_000;
    this.watchdog = setInterval(() => {
      if (this.peer && Date.now() - this.lastActivity > timeout) this.peer.close(4000, "heartbeat timeout");
    }, Math.min(30_000, Math.max(50, Math.floor(timeout / 3))));
    this.watchdog.unref?.();
    return this.bound;
  }
  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.actions?.rejectAll("OneBot reverse WebSocket stopped");
    this.peer?.terminate();
    this.peer = null;
    this.actions = null;
    this.accountHeader = undefined;
    this.gateway?.close();
    this.gateway = null;
    if (this.listener) {
      const listener = this.listener;
      this.listener = null;
      await new Promise<void>((accept) => {
        const deadline = setTimeout(accept, 3_000);
        deadline.unref?.();
        listener.close(() => { clearTimeout(deadline); accept(); });
        listener.closeAllConnections?.();
      });
    }
    this.bound = null;
  }
}
