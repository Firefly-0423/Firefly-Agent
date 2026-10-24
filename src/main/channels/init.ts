import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { loadChannelsSettings, saveChannelsSettings, } from "./settings-store";
import { channelManager, type DispatchFn } from "./manager";
import { getChannelConversationBindingStore } from "./conversation-binding-store";
import { listSessions, getSession } from "../chats/chats-store";
import { bindContextConversation, getContextBindingSnapshot, unbindContextConversation, } from "./conversation-binding-api";
import { startInboundServer, stopInboundServer } from "./inbound-server";
import { FeishuAdapter } from "./adapters/feishu";
import { ILinkBotAdapter } from "./adapters/wechat/ilink-bot-adapter";
import { NapCatAdapter } from "./adapters/qq/napcat-adapter";
import { resolveQqListenAuthRequirement } from "./adapters/qq/onebot-reverse-ws";
import { QqBotAdapter } from "./adapters/qqbot/qqbot-adapter";
import { getRecentLog, clearLog, reloadLogFromDisk } from "./message-log";
import { logger, LogTag } from "../logger";
import { pendingSenders } from "./sender-gate";
import { resolvePendingSender, withPendingSenders } from "./sender-approval";

const LOG = "[ChannelsInit]";
let configured = false;
let running = false;
let conversationLifecycle: { onUserMessage(): void; onConversationStarted(): void; onConversationEnded(): void } | null = null;
let wechat: ILinkBotAdapter | null = null;
let qq: NapCatAdapter | null = null;
let qqbot: QqBotAdapter | null = null;
export type InitializeChannelsOptions = { reloadDispatcherSettings: () => void; handleIncoming: DispatchFn; ipc?: IpcScope };
export function setChannelsConversationLifecycle(lifecycle: typeof conversationLifecycle): void { conversationLifecycle = lifecycle; }
function getPublicChannelsSettings(): Record<string, unknown> {
  const settings = loadChannelsSettings();
  return { ...settings, qq: { ...settings.qq, accessToken: undefined, hasAccessToken: Boolean(settings.qq.accessToken) },
    qqbot: { ...settings.qqbot, appSecret: undefined, hasAppSecret: Boolean(settings.qqbot.appSecret) } };
}
function registerAdapters(): void {
  const feishu = new FeishuAdapter();
  channelManager.register(feishu);
  wechat = new ILinkBotAdapter(); channelManager.register(wechat);
  qq = new NapCatAdapter(broadcastChannelsStatus); channelManager.register(qq);
  qqbot = new QqBotAdapter(broadcastChannelsStatus); channelManager.register(qqbot);
}
export function initializeChannels(options: InitializeChannelsOptions): void {
  if (configured) return;
  configured = true;
  reloadLogFromDisk();
  channelManager.setDispatcher(async (message, ingress) => {
    conversationLifecycle?.onUserMessage(); conversationLifecycle?.onConversationStarted();
    try { return await options.handleIncoming(message, ingress); }
    finally { conversationLifecycle?.onConversationEnded(); }
  });
  registerAdapters();
  registerChannelsIpc(options.ipc, options.reloadDispatcherSettings);
  pendingSenders.onChange(() => broadcastChannelsStatus());
  logger.info(LogTag.Channels, "channels module initialized");
}
export async function startChannels(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  if (running) return;
  running = true;
  try {
    const listener = await startInboundServer();
    logger.info(LogTag.InboundServer, `listening on http://127.0.0.1:${listener.port}`);
  } catch (failure) { console.error(LOG, "入站 server 启动失败:", failure); }
  if (signal?.aborted) { await stopInboundServer(); throw signal.reason; }
  await channelManager.startAll();
  logger.info(LogTag.Channels, "channels module started");
  broadcastChannelsStatus();
}
export async function shutdownChannels(): Promise<void> {
  await channelManager.stopAll(); await stopInboundServer(); configured = false; running = false;
}
function registerChannelsIpc(ipcOption: IpcScope | undefined, reloadDispatcherSettings: () => void): void {
  const scope = ipcOption ?? createIpcScope();
  scope.handle(IPC.CHANNELS_GET_CONFIG, () => getPublicChannelsSettings());
  scope.handle(IPC.CHANNELS_SAVE_CONFIG, (_event, patch: unknown) => {
    saveChannelsSettings(patch as Parameters<typeof saveChannelsSettings>[0]); reloadDispatcherSettings(); return getPublicChannelsSettings();
  });
  scope.handle(IPC.CHANNELS_GET_STATUS, () => currentChannelsStatus());
  scope.handle(IPC.CHANNELS_SENDER_RESOLVE, (_event, payload: unknown) => {
    const response = resolvePendingSender(payload, { registry: pendingSenders, load: loadChannelsSettings, save: saveChannelsSettings });
    broadcastChannelsStatus(); return response;
  });
  scope.handle(IPC.CHANNELS_QQ_RESOLVE_AUTH_REQUIREMENT, (_event, payload: unknown) => resolveQqListenAuthRequirement((payload ?? {}) as { listenMode?: unknown; customHost?: unknown }));
  scope.handle(IPC.CHANNELS_RESTART, async () => {
    await channelManager.stopAll(); await channelManager.startAll(); broadcastChannelsStatus(); return { ok: true };
  });
  scope.handle(IPC.CHANNELS_WECHAT_LOGIN_START, async () => {
    if (!wechat) return { ok: false, error: "adapter 未初始化" };
    try {
      const { fetchQrCode } = await import("./adapters/wechat/ilink-protocol-client");
      const { createQrDataUrl } = await import("./adapters/wechat/qr");
      const ticket = await fetchQrCode();
      const image = await createQrDataUrl(ticket.qrcode_img_content, 256);
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      window?.webContents.send(IPC.CHANNELS_WECHAT_QRCODE, image);
      void (async () => {
        try {
          const account = await wechat!.login(ticket.qrcode);
          await wechat!.stop(); await wechat!.start();
          window?.webContents.send(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: true, botId: account.ilinkBotId });
        } catch (failure) { window?.webContents.send(IPC.CHANNELS_WECHAT_LOGIN_DONE, { ok: false, error: String(failure) }); }
      })();
      return { ok: true, hint: "请扫描二维码" };
    } catch (failure) { return { ok: false, error: String(failure) }; }
  });
  scope.handle(IPC.CHANNELS_QQ_TEST_CONNECTION, async () => {
    if (!qq) return { ok: false, error: "QQ adapter 未初始化" };
    return await qq.testConnection();
  });
  scope.handle(IPC.CHANNELS_QQBOT_TEST_CONNECTION, async () => {
    if (!qqbot) return { ok: false, error: "QQ Bot adapter 未初始化" };
    return await qqbot.testConnection();
  });
  scope.handle(IPC.CHANNELS_LOG_GET, (_event, limit: unknown) => { const count = typeof limit === "number" && limit > 0 ? limit : 100; return getRecentLog(count); });
  scope.handle(IPC.CHANNELS_LOG_CLEAR, () => { clearLog(); return { ok: true }; });
  scope.handle(IPC.CHANNELS_CONTEXT_BINDINGS_GET, () => getContextBindingSnapshot(getChannelConversationBindingStore(), listSessions()));
  scope.handle(IPC.CHANNELS_CONTEXT_BIND, (_event, payload: unknown) => bindContextConversation(getChannelConversationBindingStore(), payload, (identifier) => getSession(identifier) !== null));
  scope.handle(IPC.CHANNELS_CONTEXT_UNBIND, (_event, sessionId: unknown) => unbindContextConversation(getChannelConversationBindingStore(), sessionId));
}
function currentChannelsStatus() { return withPendingSenders(channelManager.getAllStatus(), pendingSenders); }
export function broadcastChannelsStatus(): void {
  const snapshot = currentChannelsStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try { window.webContents.send(IPC.CHANNELS_STATUS_CHANGED, snapshot); }
    catch (failure) { console.warn(LOG, "广播失败:", failure); }
  }
}
export function broadcastChannelsInstallProgress(progress: { channel: string; phase: string; pct: number }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    try { window.webContents.send(IPC.CHANNELS_INSTALL_PROGRESS, progress); }
    catch (failure) { console.warn(LOG, "广播安装进度失败:", failure); }
  }
}
