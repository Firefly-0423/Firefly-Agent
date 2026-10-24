import { app, dialog, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "node:url";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { isDev } from "../startup/env";
import { getModelConnectionSnapshot, onModelConnectionChanged, testModelConnection } from "./model-settings";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { DEFAULT_UI_FONT, isSupportedFontFileName } from "../../shared/ui-font";
import type { GeneralSettings } from "./general-settings";
import type { TimeoutSettings } from "../../shared/timeout-types";
import type { WindowManager } from "../windows/window-manager";
import { reactChatWindow, sidebarWindow, settingsWindow } from "../windows/window-state";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { initReranker, getRerankerInstallStatus } from "../rag/reranker";
import { switchEmbeddingModel } from "../rag";
import { testVendorConnection } from "../orchestrator/vendors/test-connection";
import { fetchVendorModels, type FetchModelsInput } from "./fetch-vendor-models";
import type { VendorConfig } from "../orchestrator/vendors";
import {
  getPublicModelConfig,
  listSavedModelProfiles,
  saveModelProfile,
  setDefaultModelProfile,
  saveModelSettings,
  type ModelSettings,
} from "./model-settings";
import { getAgentRoutingView, updateAgentRouting } from "./agent-model-routing";
import { assertModelSettingsReadable } from "./model-settings";
import { resolveInputModalities } from "../orchestrator/vendors/multimodal";
import { normalizeDeclaredInputModalities } from "../../shared/input-modalities";
import { assertGeneralSettingsReadable } from "./settings-facade";
import { maskCredentials, MODEL_CREDENTIAL_FIELDS, GENERAL_CREDENTIAL_FIELDS } from "./credential-storage";
import { isFromHostDocument } from "../plugin-host/plugin-management-ipc-guard";
import { getTimeoutSettings, saveTimeoutSettings } from "./timeout-manager";
import type { syncVolcanoSearchMcp } from "./general-settings-lifecycle";
import type { syncPlaywrightMcp } from "../orchestrator/sync-mcp-builtin";

export interface SettingsIpcDependencies {
  /** 每次经由 getter 实时读取，注册时可能尚为 null。 */
  get windowManager(): WindowManager | null;
  getGeneralSettings: () => GeneralSettings;
  getModelSettings: () => ModelSettings;
  embeddingIndexService: EmbeddingIndexService;
  ipc?: IpcScope;
  proactiveLifecycle: { getProactiveChatService: () => { invalidate: () => void } | null };
  reconcileUserMemoryIndex: () => Promise<void>;
  saveGeneralSettings: (settings: Partial<GeneralSettings>) => GeneralSettings;
  saveModelSettings: (settings: Partial<ModelSettings>) => ModelSettings;
  syncPlaywrightMcp: typeof syncPlaywrightMcp;
  syncVolcanoSearchMcp: typeof syncVolcanoSearchMcp;
}

const MAX_FONT_BYTES = 50 * 1024 * 1024;

function fontDirectory(): string {
  return path.join(app.getPath("userData"), "ui-fonts");
}

/** 从源文件名推导字体展示名：去扩展名、连字符与下划线转空格、限长 80，空则用默认名。 */
function fontDisplayName(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  return stem.replace(/[-_]+/g, " ").trim().slice(0, 80) || "自定义字体";
}

/** 为 UI 生成档案视图：补充图片输入能力判定与依据，档案本身不被改写。 */
function profileViews(settings: ModelSettings, includeSecrets: boolean) {
  return listSavedModelProfiles(settings).map((profile) => {
    const judged = resolveInputModalities({
      model: profile.model,
      provider: profile.provider,
      declaredSource: profile.inputModalitiesSource,
      declared: profile.inputModalities,
    });
    return { ...(includeSecrets ? profile : maskCredentials(profile, MODEL_CREDENTIAL_FIELDS)), multimodal: judged.image, multimodalSource: judged.source };
  });
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 包装一个依赖“模型配置可读”的处理函数：先断言，再执行。 */
function guardModelRead<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    assertModelSettingsReadable();
    return handler(...args);
  };
}

export function registerSettingsIpc(deps: SettingsIpcDependencies): () => void {
  const ipc = deps.ipc ?? createIpcScope();
  // 以下依赖在注册时一次性取出，与原先的解构行为一致。windowManager 仍然保持实时读取。
  const getGeneralSettings = deps.getGeneralSettings;
  const saveGeneralSettings = deps.saveGeneralSettings;
  const getModelSettings = deps.getModelSettings;
  const saveModelSettings = deps.saveModelSettings;
  const proactiveLifecycle = deps.proactiveLifecycle;
  const reconcileUserMemoryIndex = deps.reconcileUserMemoryIndex;
  const embeddingIndexService = deps.embeddingIndexService;
  const syncVolcanoSearchMcp = deps.syncVolcanoSearchMcp;
  const syncPlaywrightMcp = deps.syncPlaywrightMcp;

  const isSettingsSender = (event: IpcMainInvokeEvent): boolean => {
    const settingsDoc = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : null;
    return isFromHostDocument(event, settingsDoc, "settings");
  };

  const assertModelSettingsSender = (event: IpcMainInvokeEvent, allowChat = false): void => {
    const chatDoc = reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null;
    if (!isSettingsSender(event) && !(allowChat && isFromHostDocument(event, chatDoc, "react"))) {
      throw new Error("MODEL_SETTINGS_FORBIDDEN");
    }
  };

  const sendToAuxWindows = (channel: string, payload: unknown): void => {
    [reactChatWindow, sidebarWindow, settingsWindow].forEach((target) => {
      if (target && !target.isDestroyed()) {
        target.webContents.send(channel, payload);
      }
    });
  };

  const pushModelConfig = (settings: ModelSettings = getModelSettings()): void => {
    sendToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
  };

  const profileList = (settings: ModelSettings, includeSecrets: boolean) => ({
    profiles: profileViews(settings, includeSecrets),
    defaultModelProfileId: settings.defaultModelProfileId,
  });

  /** 设置页与聊天页可以保存通用设置；插件启停只能通过插件管理器。 */
  const isGeneralWriter = (event: IpcMainInvokeEvent): boolean => {
    const settingsDoc = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : null;
    const chatDoc = reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null;
    return isFromHostDocument(event, settingsDoc, "settings") || isFromHostDocument(event, chatDoc, "react");
  };

  // ---- 模型档案与代理路由 ----
  ipc.handle(IPC.SETTINGS_GET_CONFIG, (event: IpcMainInvokeEvent) => {
    assertModelSettingsSender(event);
    assertModelSettingsReadable();
    return getModelSettings();
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILES_LIST, (event: IpcMainInvokeEvent) => {
    assertModelSettingsSender(event, true);
    assertModelSettingsReadable();
    return profileList(getModelSettings(), isSettingsSender(event));
  });
  ipc.handle(IPC.SETTINGS_AGENT_ROUTING_GET, guardModelRead(() => getAgentRoutingView(getModelSettings())));
  ipc.handle(
    IPC.SETTINGS_AGENT_ROUTING_UPDATE,
    guardModelRead((_event: unknown, input: unknown) => getAgentRoutingView(saveModelSettings(updateAgentRouting(getModelSettings(), input)))),
  );
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SAVE, (event: IpcMainInvokeEvent, profile) => {
    assertModelSettingsSender(event);
    const outcome = saveModelProfile(profile as Parameters<typeof saveModelProfile>[0]);
    const newest = outcome.settings.modelProfiles?.at(-1);
    if (outcome.added && outcome.settings.defaultModelProfileId === newest?.id) {
      pushModelConfig(outcome.settings);
    }
    return { added: outcome.added, ...profileList(outcome.settings, true) };
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_DELETE, (event: IpcMainInvokeEvent, id: unknown) => {
    assertModelSettingsSender(event, true);
    if (typeof id !== "string") { return null; }
    const current = getModelSettings();
    const kept = listSavedModelProfiles(current).filter((profile) => profile.id !== id);
    const nextDefault = current.defaultModelProfileId === id ? kept[0]?.id : current.defaultModelProfileId;
    const saved = saveModelSettings({ modelProfiles: kept, defaultModelProfileId: nextDefault });
    pushModelConfig(saved);
    return profileList(saved, isSettingsSender(event));
  });
  ipc.handle(IPC.SETTINGS_MODEL_PROFILE_SET_DEFAULT, (event: IpcMainInvokeEvent, id: unknown) => {
    assertModelSettingsSender(event, true);
    if (typeof id !== "string") { return null; }
    const saved = setDefaultModelProfile(id);
    pushModelConfig(saved);
    return profileList(saved, isSettingsSender(event));
  });

  // ---- 通用设置读取 ----
  ipc.handle(IPC.SETTINGS_GET_GENERAL, (event: IpcMainInvokeEvent) => {
    const settingsDoc = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : null;
    const chatDoc = reactChatWindow && !reactChatWindow.isDestroyed() ? reactChatWindow.webContents : null;
    const petSender = Boolean(
      event?.sender && deps.windowManager?.isPetWindowSender(event.sender.id) && isFromHostDocument(event, event.sender, "pet"),
    );
    const callerAllowed = isFromHostDocument(event, settingsDoc, "settings")
      || isFromHostDocument(event, chatDoc, "react")
      || petSender;
    const readCurrent = (): GeneralSettings => {
      assertGeneralSettingsReadable();
      return getGeneralSettings();
    };
    if (!callerAllowed) { throw new Error("GENERAL_SETTINGS_FORBIDDEN"); }
    const settings = readCurrent();
    return isSettingsSender(event) ? settings : maskCredentials(settings, GENERAL_CREDENTIAL_FIELDS);
  });

  ipc.handle(IPC.SETTINGS_GET_TIMEOUT_SETTINGS, () => getTimeoutSettings());
  ipc.handle(IPC.SETTINGS_SAVE_TIMEOUT_SETTINGS, (_event, settings: Partial<TimeoutSettings>) => saveTimeoutSettings(settings));

  ipc.handle(IPC.UI_COLORS_GET, () => getGeneralSettings().uiColors);
  ipc.handle(IPC.UI_THEME_GET, () => getGeneralSettings().uiTheme);
  ipc.handle(IPC.UI_FONT_GET, () => getGeneralSettings().uiFont);

  // ---- 自定义界面字体 ----
  ipc.handle(IPC.SETTINGS_PICK_UI_FONT, async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "字体文件", extensions: ["ttf", "otf"] }],
    });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });

  ipc.handle(IPC.SETTINGS_IMPORT_UI_FONT, (_event, sourcePath: unknown) => {
    if (typeof sourcePath !== "string" || sourcePath === "") {
      throw new Error("未选择字体文件");
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (![".ttf", ".otf"].includes(ext)) {
      throw new Error("仅支持 .ttf 或 .otf 字体文件");
    }
    const info = fs.statSync(sourcePath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_FONT_BYTES) {
      throw new Error("字体文件无效或超过 50 MB");
    }

    const storedName = `custom-${randomUUID()}${ext}`;
    if (!isSupportedFontFileName(storedName)) {
      throw new Error("字体文件名无效");
    }
    const dir = fontDirectory();
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(dir, storedName));

    const previous = getGeneralSettings().uiFont;
    const saved = saveGeneralSettings({
      uiFont: { kind: "custom", fileName: storedName, displayName: fontDisplayName(sourcePath) },
    });
    if (previous.kind === "custom" && previous.fileName !== storedName && isSupportedFontFileName(previous.fileName)) {
      fs.rmSync(path.join(dir, previous.fileName), { force: true });
    }
    return saved.uiFont;
  });

  ipc.handle(IPC.SETTINGS_RESET_UI_FONT, () => {
    const previous = getGeneralSettings().uiFont;
    const saved = saveGeneralSettings({ uiFont: DEFAULT_UI_FONT });
    if (previous.kind === "custom" && isSupportedFontFileName(previous.fileName)) {
      fs.rmSync(path.join(fontDirectory(), previous.fileName), { force: true });
    }
    return saved.uiFont;
  });

  /** 保存后需要联动的服务：搜索 MCP、桌面 MCP、主动消息。 */
  const runPostSaveHooks = async (patch: Partial<GeneralSettings>, saved: GeneralSettings): Promise<void> => {
    const has = (key: keyof GeneralSettings) => key in patch;
    if (has("searchMinimaxKey") || has("searchEngine")) {
      await syncVolcanoSearchMcp(saved);
    }
    if (has("playwrightMcpEnabled")) {
      await syncPlaywrightMcp(saved);
    }
    if (has("proactiveChatMode") || has("proactiveDeliveryTarget")) {
      proactiveLifecycle.getProactiveChatService()?.invalidate();
    }
  };

  ipc.handle(IPC.SETTINGS_SAVE_GENERAL, async (event: IpcMainInvokeEvent, settings: Partial<GeneralSettings>) => {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("GENERAL_SETTINGS_INVALID");
    }
    if ("plugins" in settings) {
      // 在任何落盘或副作用发生之前整体拒绝。
      throw new Error("GENERAL_SETTINGS_PLUGINS_FORBIDDEN");
    }
    if (!isGeneralWriter(event)) {
      throw new Error("GENERAL_SETTINGS_FORBIDDEN");
    }
    const saved = saveGeneralSettings(settings);
    await runPostSaveHooks(settings, saved);
    return isSettingsSender(event) ? saved : maskCredentials(saved, GENERAL_CREDENTIAL_FIELDS);
  });

  ipc.on(IPC.SETTINGS_SET_PET_ALWAYS_ON_TOP, (_event, value: boolean) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petAlwaysOnTop: Boolean(value) });
    deps.windowManager?.setPetWindowAlwaysOnTop(saved.petAlwaysOnTop);
  });
  ipc.on(IPC.SETTINGS_SET_PET_VISIBLE, (_event, value: boolean) => {
    saveGeneralSettings({ ...getGeneralSettings(), petVisible: Boolean(value) });
  });
  ipc.on(IPC.SETTINGS_SET_PET_ZOOM, (_event, value: number) => {
    const saved = saveGeneralSettings({ ...getGeneralSettings(), petZoom: Number(value) });
    deps.windowManager?.applyPetWindowZoom(saved.petZoom);
  });

  // ---- 公开模型配置与连接状态 ----
  ipc.handle(IPC.MODEL_CONFIG_GET, guardModelRead(() => getPublicModelConfig()));
  ipc.handle(IPC.SETTINGS_SAVE_CONFIG, (event: IpcMainInvokeEvent, settings: Partial<ModelSettings>) => {
    assertModelSettingsSender(event);
    const saved = saveModelSettings(settings);
    pushModelConfig(saved);
    return saved;
  });

  const unsubscribeConnections = onModelConnectionChanged((snapshot) => {
    sendToAuxWindows(IPC.MODEL_CONNECTION_CHANGED, snapshot);
    pushModelConfig();
  });
  ipc.handle(IPC.MODEL_CONNECTION_GET, guardModelRead(() => getModelConnectionSnapshot()));

  /**
   * 只有设置窗口的主 frame 才能发起会携带档案 API Key 的外部请求，
   * 且其地址（去掉 hash）必须等于设置页的开发地址或打包产物地址。
   */
  const assertSettingsSender = (event: IpcMainInvokeEvent): void => {
    const win = settingsWindow;
    const senderOk = Boolean(win)
      && !win!.isDestroyed()
      && !win!.webContents.isDestroyed()
      && event.sender === win!.webContents
      && Boolean(event.senderFrame)
      && event.senderFrame === event.sender.mainFrame;
    if (!senderOk) { throw new Error("MODEL_CONNECTION_FORBIDDEN"); }

    const expected = isDev
      ? "http://localhost:5173/settings/"
      : pathToFileURL(path.join(app.getAppPath(), "dist", "renderer", "settings", "index.html")).href;
    let observed: string;
    try {
      const probe = new URL(event.senderFrame!.url);
      probe.hash = "";
      observed = probe.href;
    } catch {
      throw new Error("MODEL_CONNECTION_FORBIDDEN");
    }
    if (observed !== expected) { throw new Error("MODEL_CONNECTION_FORBIDDEN"); }
  };

  ipc.handle(IPC.SETTINGS_TEST_CONNECTION, async (event: IpcMainInvokeEvent, cfg: VendorConfig) => {
    assertSettingsSender(event);
    return testModelConnection(cfg, testVendorConnection);
  });

  // 设置页“获取模型列表”：只返回厂商给出的 id 与展示名，不回传任何密钥。
  ipc.handle(IPC.SETTINGS_FETCH_MODELS, async (event: IpcMainInvokeEvent, input: FetchModelsInput) => {
    assertSettingsSender(event);
    if (!input || typeof input !== "object") {
      return { ok: false, error: "MISSING_BASE_URL" };
    }
    const transport = input.explicitTransport;
    const explicitTransport = transport === "openai" || transport === "anthropic" || transport === "responses" ? transport : undefined;
    return fetchVendorModels({
      provider: asText(input.provider),
      baseUrl: asText(input.baseUrl),
      apiKey: asText(input.apiKey),
      explicitTransport,
    });
  });

  // 输入类型的生效结果：编辑器据此实时显示，与档案列表共用 resolveInputModalities。
  ipc.handle(IPC.SETTINGS_RESOLVE_INPUT_MODALITIES, (event: IpcMainInvokeEvent, input: unknown) => {
    assertSettingsSender(event);
    const raw: Record<string, unknown> = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const declared = normalizeDeclaredInputModalities(raw.inputModalities, raw.inputModalitiesSource);
    return resolveInputModalities({
      model: asText(raw.model),
      provider: asText(raw.provider),
      declaredSource: declared.inputModalitiesSource,
      declared: declared.inputModalities,
    });
  });

  // ---- 向量模型与重排序 ----
  ipc.handle(IPC.EMBEDDING_SET_MODEL, async (_event, modelKey: string) => {
    console.log("[Firefly] embedding model switch requested:", modelKey);
    try {
      const outcome = await switchEmbeddingModel(modelKey);
      if (outcome.ok) {
        await reconcileUserMemoryIndex();
        saveModelSettings({ embeddingModel: "bgem3" });
        pushModelConfig();
        embeddingIndexService.invalidateStickerEmbeddingIndex();
        embeddingIndexService.refreshStickerEmbeddingIndex("embedding-model-switch");
      }
      return outcome;
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      console.error("[Firefly] embedding model switch failed:", reason);
      return { ok: false, clearedEntries: 0, error: reason };
    }
  });

  ipc.handle(IPC.RERANKER_SET_MODE, async (_event, mode: "standard" | "none") => {
    saveModelSettings({ ...getModelSettings(), rerankerMode: mode });
    await initReranker(mode);
    console.log("[Firefly] reranker mode switched to", mode);
    return true;
  });
  ipc.handle(IPC.RERANKER_GET_STATUS, () => getRerankerInstallStatus());

  ipc.handle(IPC.MODEL_GET_INSTALL_STATUS, () => {
    const modelStatus = require("../rag/model-status");
    return modelStatus.getModelInstallStatus();
  });

  return unsubscribeConnections;
}
