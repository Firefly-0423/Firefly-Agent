import { BrowserWindow, screen } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { createWindowDragController } from "./window-drag";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors";
import { normalizeReasoningPreference } from "../../shared/reasoning";
import {
  getDefaultModelProfile,
  listSavedModelProfiles,
  loadModelSettings,
  resolveModelSettingsProfile,
  saveModelProfile,
  saveModelSettings,
} from "../settings/model-settings";
import { resolveVendorRuntimeSettings } from "../orchestrator/vendors/runtime-settings";
import { resolveTransport } from "../orchestrator/vendors/transport-detector";
import { getSession } from "./chats-store";
import { getActiveLive2dWorkRunCount } from "../orchestrator/live2d-work-signal";
import { describePendingAttachment } from "../rag/file-ingest";
import { captionImageSafe, buildImageCaptionPrompt, validateCaptionImagePath } from "../chat/image-caption";
import { resolveCaptionVisionConfig, resolveImageRoute } from "../orchestrator/image-router";
import type { WindowManager } from "../windows/window-manager";
import { reactChatSession, reactChatWindow } from "../windows/window-state";
import { activeChatTargetRegistry, parseActiveTargetPayload } from "../plugin-host/active-chat-target";

export interface ChatUiIpcDependencies {
  /** Refresh private browser ownership synchronously after the trusted target changes. */
  onActiveTargetChanged?: () => void;
  /** 共享的 IPC scope，便于退出时一起注销；不传则自建独立 scope。 */
  ipc?: IpcScope;
  get windowManager(): WindowManager | null;
  live2dWindowLifecycle: { getDiagnostics(): unknown };
}

// 当前活动目标（会话、模式、渲染目标标识、失效监听）统一放在
// activeChatTargetRegistry，语音输入租约据此冻结提交目标，这里不再保存模块级变量。

/** 保持旧接口：返回当前活动会话 ID，没有目标或在欢迎页时为 null。 */
export function getActiveChatSessionId(): string | null {
  const active = activeChatTargetRegistry.getActive();
  return active?.sessionId ?? null;
}

type Payload = Record<string, unknown>;

// 把任意载荷安全地看成对象，非对象一律当作空对象
function asRecord(value: unknown): Payload {
  return value && typeof value === "object" ? (value as Payload) : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// 读取推理状态：档案优先级为 会话绑定 > 渲染端暂存（欢迎页）> 默认档案。
// 不能退回顶层镜像，它可能是空壳（厂商指向别家、三项全空），
// 与渠道机器人不回复是同一个病根。
function readReasoningState(payload?: { sessionId?: unknown; modelProfileId?: unknown }) {
  const base = loadModelSettings();
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
  const session = sessionId ? getSession(sessionId) : undefined;
  const wantedId = session?.modelProfileId ?? nonEmptyString(payload?.modelProfileId);
  const profile = listSavedModelProfiles(base).find((p) => p.id === wantedId) ?? getDefaultModelProfile(base);
  const settings = profile ? resolveModelSettingsProfile(base, profile.id) : base;
  const capability = getCapabilityOrOpenAI(settings.provider);
  return {
    providerKey: settings.provider,
    providerId: capability.id,
    model: settings.model,
    preference: settings.reasoning,
    // 档案声明的档位；未声明时渲染端按型号规则表兜底
    reasoningLevels: settings.reasoningLevels,
    thinkingOverride: resolveVendorRuntimeSettings(settings).thinkingOverride,
    // PRO 档只在 Responses 协议下存在，界面据此决定是否展示
    transport: resolveTransport({
      provider: settings.provider,
      explicitTransport: settings.explicitTransport,
      baseUrl: settings.baseUrl,
    }),
    modelProfileId: profile?.id ?? null,
  };
}

// 写入推理偏好，目标与读取对称：会话档案 > 渲染端暂存档案 > 默认档案 > 顶层镜像。
// 否则读的是档案、写的是顶层，切换就等于没切。
function writeReasoningPreference(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const body = raw as Payload;
  const { providerKey } = body;
  if (typeof providerKey !== "string" || typeof body.preference !== "object" || !body.preference) return;
  const preference = normalizeReasoningPreference(body.preference);
  if (!preference) return;

  const current = loadModelSettings();
  const session = typeof body.sessionId === "string" ? getSession(body.sessionId) : undefined;

  if (session?.modelProfileId) {
    const bound = listSavedModelProfiles(current).find((p) => p.id === session.modelProfileId);
    if (bound && bound.provider === providerKey) saveModelProfile({ ...bound, reasoning: preference });
    return;
  }

  const saved = listSavedModelProfiles(current);
  const target = saved.find((p) => p.id === nonEmptyString(body.modelProfileId)) ?? getDefaultModelProfile(current);
  if (target) {
    if (target.provider === providerKey) saveModelProfile({ ...target, reasoning: preference });
    return;
  }

  if (current.provider === providerKey) saveModelSettings({ reasoning: preference });
}

export function registerChatUiIpc(deps: ChatUiIpcDependencies): void {
  const ipc = deps.ipc ?? createIpcScope();
  const windowOf = (event: { sender: Electron.WebContents }) => BrowserWindow.fromWebContents(event.sender);

  // 桌宠只会收到“工作中”跳变事件；窗口晚于 true 事件加载或重载时，用这个快照补齐当前状态。
  ipc.handle(IPC.LIVE2D_GET_WORKING, () => getActiveLive2dWorkRunCount() > 0);

  ipc.on(IPC.CHAT_MINIMIZE, (event) => {
    windowOf(event)?.minimize();
  });

  ipc.on(IPC.CHAT_CLOSE, (event) => {
    windowOf(event)?.close();
  });

  ipc.on(IPC.CHAT_TOGGLE_MAXIMIZE, (event) => {
    const win = windowOf(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipc.handle(IPC.CHAT_IS_MAXIMIZED, (event) => windowOf(event)?.isMaximized() ?? false);

  // 无边框透明窗口最大化后，系统不会因拖动标题栏而还原；
  // 由渲染端发起拖动，这里负责还原窗口并跟随光标。
  const drag = createWindowDragController({
    getCursor: () => screen.getCursorScreenPoint(),
    getWorkArea: (point) => screen.getDisplayNearestPoint(point).workArea,
  });
  ipc.on(IPC.CHAT_WINDOW_DRAG_START, (event) => {
    const win = windowOf(event);
    if (win) drag.start(win);
  });
  ipc.on(IPC.CHAT_WINDOW_DRAG_END, () => drag.stop());

  ipc.handle(IPC.CHAT_GET_REASONING_STATE, (_event, payload?: { sessionId?: unknown; modelProfileId?: unknown }) =>
    readReasoningState(payload),
  );

  ipc.handle(IPC.CHAT_SET_REASONING, (_event, payload: unknown) => writeReasoningPreference(payload));

  ipc.handle(IPC.CHAT_INGEST_FILES, async (_event, entries: unknown) => {
    const files = (Array.isArray(entries) ? entries : []).filter(
      (entry): entry is { path: string; mime?: string } =>
        typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string",
    );
    if (!files.length) return [];
    try {
      return files.map((file) => describePendingAttachment(file.path, file.mime));
    } catch (err: any) {
      console.error("[Firefly] ingestFiles ERROR:", err?.message || err);
      return [];
    }
  });

  ipc.handle(IPC.CHAT_CAPTION_IMAGE, async (_event, payload: unknown) => {
    const body = payload && typeof payload === "object" ? (payload as Payload) : undefined;
    const filePath = body?.filePath;
    const annotated = body ? body.hasAnnotations === true : false;
    const vision = resolveCaptionVisionConfig(resolveModelSettingsProfile(loadModelSettings()));
    if (!vision.ok) return { ok: false, error: vision.error };
    return captionImageSafe(filePath, buildImageCaptionPrompt(annotated), vision.config);
  });

  ipc.handle(IPC.CHAT_GET_IMAGE_PREVIEW, (_event, payload: unknown) => {
    const checked = validateCaptionImagePath(asRecord(payload).filePath);
    if (!checked.ok) return { ok: false, error: checked.error };
    return { ok: true, dataUrl: `data:${checked.mime};base64,${checked.buffer.toString("base64")}` };
  });

  ipc.handle(IPC.CHAT_GET_IMAGE_SEND_STRATEGY, (_event, payload: unknown) => {
    // 按会话判断：会话绑定了档案时，按该档案的厂商和型号推断图片能力；
    // 没有 sessionId 或会话没绑档案，则使用默认档案。
    const sessionId = asRecord(payload).sessionId;
    let settings = loadModelSettings();
    if (typeof sessionId === "string" && sessionId) {
      const boundProfileId = getSession(sessionId)?.modelProfileId;
      if (boundProfileId) settings = resolveModelSettingsProfile(settings, boundProfileId);
    }
    // 路由统一由 image-router 决定，返回形状仍是 { mode: "direct" | "caption" }。
    // reject（型号不支持图片）按 caption 处理：转述请求会拿到路由给出的明确错误并如实展示，
    // 而不是假装可以直发。
    const route = resolveImageRoute("attachment", settings);
    return { mode: route.mode === "direct" ? ("direct" as const) : ("caption" as const) };
  });

  // 状态栏入口：打开或复用 reactChatWindow。
  // 必须每次从 deps 读取 windowManager 这个 getter，不能在注册时解构：
  // 注册发生在模块加载阶段，那时它还是 null，解构会把 null 固定下来，
  // 后面的 ?. 永远短路，按钮就打不开窗口了。
  ipc.handle(IPC.CHATS_OPEN_IN_REACT_WINDOW, (_event, sessionId: string) => {
    if (typeof sessionId !== "string" || !sessionId.trim().length) return false;
    void deps.windowManager?.openReactChatWindow(sessionId);
    return true;
  });

  // reactChatWindow 通知 main：ChatPage 已经挂好 IPC 监听
  ipc.on(IPC.CHATS_REACT_READY, (event) => {
    const win = reactChatWindow;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    const queued = reactChatSession.markReady();
    if (queued) win.webContents.send(IPC.CHATS_REACT_SWITCH_SESSION, queued);
  });

  // 聊天窗口启动或切换会话时上报活跃目标（会话、模式、渲染目标标识）。
  // 只有聊天窗口自己的 webContents 才能登记，其他窗口的上报会被忽略。
  ipc.handle(IPC.CHATS_SET_ACTIVE_SESSION, (event, payload: unknown) => {
    const chat = reactChatWindow;
    if (!chat || chat.isDestroyed() || event.sender !== chat.webContents) return false;

    if (payload == null) {
      activeChatTargetRegistry.clearActive(event.sender);
    } else {
      const target = parseActiveTargetPayload(payload);
      if (target) activeChatTargetRegistry.setActive({ sender: event.sender, ...target });
    }
    deps.onActiveTargetChanged?.();
    return true;
  });
}
