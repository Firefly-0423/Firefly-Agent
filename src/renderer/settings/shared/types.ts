import type { ApiTransport } from "../../../shared/api-endpoint";
import type { ChatAppearanceSettings } from "../../../shared/chat-appearance";
import type { ExternalSkillsApi } from "../../../shared/external-skills";
import type { InputModality, InputModalityResolution, InputModalitySource } from "../../../shared/input-modalities";
import type { MemoryPolicyPanelApi, ShadowPanelApi } from "../../../shared/memory-panel-contracts";
import type { ProactiveChatMode, ProactiveDeliveryTarget, SegmentedOutputMode } from "../../../shared/preferences";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";
import type { ReasoningLevelsConfig, ReasoningPreference } from "../../../shared/reasoning";
import type { AgentRoutingView, AgentRoutingUpdate } from "../../../shared/specialist-agents";
import type { TimeoutSettings } from "../../../shared/timeout-types";
import type { UiColors } from "../../../shared/ui-colors";
import type { UiFont } from "../../../shared/ui-font";
import type { UiIcon } from "../../../shared/ui-icon";
import type { UiTheme } from "../../../shared/ui-theme";
import type { CustomEndpointMode } from "../custom-endpoint-state";

// 档案、界面配置与桥接接口各自描述，公共结果在文件内复用。
type Acknowledgement = { ok: boolean; error?: string };
type ConnectionResult = { ok: boolean; error?: string; detail?: Record<string, unknown> };
type McpChangeResult = { ok: boolean; toolIds?: string[]; error?: string; reason?: string };
type WindowMode = "chat" | "work" | "code";
type TaskMode = "work" | "code";
type ChannelPhase = { phase?: string; message?: string };
type ProfileDetails = {
  nickname: string; callPreference: string; birthday: string; timezone: string;
  avatarPath: string; defaultCity: string; gender: string;
};

type ModelProfileDraft = {
  id?: string; provider: string; displayName?: string; baseUrl: string; model: string;
  apiKey: string; explicitTransport?: ApiTransport; reasoning?: ReasoningPreference;
  reasoningLevels?: ReasoningLevelsConfig; contextWindowTokens?: number;
  inputModalities?: InputModality[]; inputModalitiesSource?: InputModalitySource;
};
type ModelProfileRecord = Omit<ModelProfileDraft, "id"> & {
  id: string; multimodal?: boolean; multimodalSource?: InputModalityResolution["source"];
};
type ProfileCatalog = { profiles: ModelProfileRecord[]; defaultModelProfileId?: string };
type ToolCatalogEntry = {
  id: string; name: string; description: string; enabled: boolean;
  modes: Array<WindowMode> | null; deprecated: string | null;
};
type SkillCatalogEntry = {
  id: string; name: string; description: string; descriptionZh?: string;
  enabled: boolean; source: string; modes: TaskMode[] | null;
  version?: string; references: string[];
};
type McpServerEntry = {
  id: string; name: string; connected: boolean; toolCount: number;
  toolIds: string[]; enabled?: boolean; failure?: string;
};
type ContextBindingCatalog = {
  externalChats: Array<{
    sessionId: string; channel: string; chatId: string; chatType: "private" | "group";
    senderName?: string; lastAt: number;
  }>;
  bindings: Array<{ sessionId: string; conversationId: string; updatedAt: number }>;
  conversations: Array<{ id: string; title: string; mode: string; updatedAt: number }>;
};

export type FetchedModel = {
  inputModalities?: InputModality[];
  id: string; name?: string;
};

export type ProviderProfile = {
  displayName?: string; reasoning?: ReasoningPreference;
  baseUrl: string; apiKey: string; model: string;
  explicitTransport?: ApiTransport;
};

export type ModelSettings = {
  mode: "auto" | "manual"; provider: string;
  baseUrl: string; model: string; apiKey: string; displayName?: string;
  explicitTransport?: ApiTransport; reasoning?: ReasoningPreference;
  perProvider?: Record<string, ProviderProfile>;
  specialistModelProfiles?: Record<string, string>;
  agentModelProfiles?: Record<string, string>;
  contextWindowTokens?: number; disableMaxToken?: boolean;
  thinkingOverride?: -1 | 0 | 1; embeddingDimensions?: number;
  chatRequestTimeoutSec: number;
  stickerSize: "small" | "standard" | "large";
  stickerEnabled: boolean; stickerSimilarityThreshold: number;
};

export type ModelPreset = {
  mainModels: string[]; transport: ApiTransport;
  providerName: string; shortName: string;
  baseUrl: string; anthropicBaseUrl?: string;
  iconUrl: string; websiteUrl?: string;
  disabled?: boolean; hiddenInPresetList?: boolean;
  customEndpointMode?: CustomEndpointMode;
};

export type GeneralSettings = ChatAppearanceSettings & {
  maxParallelToolCalls: number; maxToolRounds: number; runTimeoutMinutes: number;
  chatSocialContextEnabled: boolean;
  petAlwaysOnTop: boolean; petVisible: boolean; petZoom: number;
  sidebarVisible: boolean; toastSoundEnabled: boolean; launchAtLogin: boolean;
  language: "zh-CN" | "en";
  uiTheme: UiTheme; uiColors: UiColors; uiFont: UiFont; uiIcon: UiIcon;
  uiFontSize: number; chatFontSize: number; codeFontSize: number;
  chatLineHeight: number; chatParaSpacing: number;
  segmentedOutputMode: SegmentedOutputMode;
  proactiveChatMode: ProactiveChatMode; proactiveDeliveryTarget: ProactiveDeliveryTarget;
  screenshotHotkey?: string;
  asrEngine?: "off" | "mossland" | "aliyun" | "local";
  asrMosslandKey?: string; asrAliyunAppKey?: string;
  asrAliyunAccessKeyId?: string; asrAliyunAccessKeySecret?: string;
  asrLanguage?: "zh" | "en" | "auto";
  weatherSource: "open-meteo" | "amap"; weatherEnabled: boolean;
  amapKey: string; travelEnabled: boolean; musicEnabled: boolean;
  playwrightMcpEnabled: boolean;
  searchEngine: "off" | "bocha" | "tavily" | "minimax" | "anySearch";
  searchBochaKey: string; searchTavilyKey: string;
  searchMinimaxKey: string; searchAnySearchKey: string;
  emailEnabled: boolean; emailSmtpHost: string; emailSmtpPort: number;
  emailSmtpSecure: boolean; emailSmtpUser: string; emailSmtpPass: string;
  emailFromName: string;
};

export type UserApi = {
  getProfile: () => Promise<ProfileDetails>;
  getAvatar: () => Promise<string | null>;
  saveProfile: (profile: Record<string, unknown>) => Promise<unknown>;
  uploadAvatar: () => Promise<{ avatarPath: string } | null>;
  onAvatarChanged: (callback: () => void) => () => void;
};

export type MemoryPanelPayload = {
  importedDocs: Array<{
    lastImportedAt: number; chunkCount: number;
    fileName: string; importId: string | null;
  }>;
};

export type MemoryPanelApi = MemoryPolicyPanelApi & Partial<ShadowPanelApi> & {
  deleteImportedDoc: (importId: string, fileName?: string) => Promise<{ ok: boolean; deleted: number }>;
  getData: () => Promise<MemoryPanelPayload>;
};

export type SettingsApi = {
  // 窗口及通用配置。
  close: () => void; minimize: () => void;
  getGeneral: () => Promise<GeneralSettings>;
  saveGeneral: (config: Partial<GeneralSettings>) => Promise<GeneralSettings>;
  getConfig: () => Promise<ModelSettings>;
  saveConfig: (config: Partial<ModelSettings>) => Promise<ModelSettings>;
  getTimeoutSettings: () => Promise<TimeoutSettings>;
  saveTimeoutSettings: (config: Partial<TimeoutSettings>) => Promise<TimeoutSettings>;
  getAgentRouting?: () => Promise<AgentRoutingView>;
  updateAgentRouting?: (input: AgentRoutingUpdate) => Promise<AgentRoutingView>;
  onSwitchSection?: (callback: (section: string) => void) => (() => void) | void;

  // 模型目录与连接测试。
  listModelProfiles?: () => Promise<ProfileCatalog>;
  saveModelProfile?: (profile: ModelProfileDraft) => Promise<{ added: boolean; profiles: unknown[]; defaultModelProfileId?: string }>;
  deleteModelProfile?: (id: string) => Promise<unknown>;
  setDefaultModelProfile?: (id: string) => Promise<unknown>;
  fetchModels?: (input: { provider: string; baseUrl: string; apiKey: string; explicitTransport?: ApiTransport }) => Promise<{ ok: true; models: FetchedModel[] } | { ok: false; error: string }>;
  resolveInputModalities?: (input: { provider: string; model: string; inputModalities?: InputModality[]; inputModalitiesSource?: InputModalitySource }) => Promise<InputModalityResolution>;
  testConnection?: (config: { provider: string; baseUrl: string; model: string; apiKey: string; explicitTransport?: ApiTransport; reasoning?: ReasoningPreference }) => Promise<{ ok: boolean; latency: number; sample?: string; error?: string }>;

  // 外观与桌面能力。
  pickUiFont: () => Promise<string | null>;
  importUiFont: (sourcePath: string) => Promise<UiFont>;
  resetUiFont: () => Promise<UiFont>;
  setPetAlwaysOnTop: (value: boolean) => void;
  setPetVisible: (value: boolean) => void;
  setPetZoom: (value: number) => void;
  beginScreenshotHotkeyCapture: () => Promise<boolean>;
  endScreenshotHotkeyCapture: () => Promise<boolean>;
  openStickerManager: () => Promise<Acknowledgement>;
  stickerPickFile?: () => Promise<string | null>;
  stickerAdd?: (payload: { sourcePath: string; id: string; description: string; phrases: string[] }) => Promise<unknown>;
  embeddingSetModel?: (model: string) => Promise<{ ok: boolean; clearedEntries?: number; error?: string }>;
  rerankerSetMode?: (mode: string) => Promise<boolean>;

  // 工具、技能和 MCP。
  externalSkills?: ExternalSkillsApi;
  setSkillEnabled?: (id: string, enabled: boolean) => Promise<Acknowledgement>;
  getToolCatalog?: () => Promise<ToolCatalogEntry[]>;
  getToolModeOverrides?: () => Promise<Record<string, Partial<Record<WindowMode, boolean>>>>;
  setToolModeOverride?: (toolId: string, mode: WindowMode, enabled: boolean) => Promise<Acknowledgement>;
  getSkillCatalog?: () => Promise<SkillCatalogEntry[]>;
  rescanSkills?: () => Promise<{ ok: boolean; count: number; error?: string }>;
  translateSkillDescriptions?: () => Promise<{ ok: boolean; translated?: Record<string, string>; error?: string }>;
  getSkillModeOverrides?: () => Promise<Record<string, Partial<Record<TaskMode, boolean>>>>;
  setSkillModeOverride?: (skillId: string, mode: TaskMode, enabled: boolean) => Promise<Acknowledgement>;
  addMcpServer?: (config: unknown) => Promise<McpChangeResult>;
  removeMcpServer?: (serverId: string) => Promise<Acknowledgement>;
  setMcpServerEnabled?: (serverId: string, enabled: boolean) => Promise<McpChangeResult>;
  listMcpServers?: () => Promise<McpServerEntry[]>;
  getPermissionLevel?: () => Promise<{ level: "read-only" | "scoped" | "per-action" | "full" }>;
  setPermissionLevel?: (level: string) => Promise<{ ok: boolean; level?: string; error?: string }>;
  setPlanMode?: (payload: { conversationId: string; target: "on" | "off"; workspaceRoot?: string }) => Promise<{ ok: boolean; state?: string; reason?: string }>;
  getPlanState?: (conversationId: string) => Promise<{ state: string }>;
  onPlanStateChanged?: (callback: (payload: { conversationId: string; state: string }) => void) => (() => void) | void;

  // 渠道配置与状态订阅。
  channelsGetConfig: () => Promise<any>;
  channelsSaveConfig: (patch: unknown) => Promise<any>;
  channelsRestart: () => Promise<{ ok: boolean }>;
  channelsSenderResolve: (payload: { channel: string; senderId: string; action: "approve" | "dismiss" }) => Promise<Acknowledgement>;
  channelsQqTestConnection: () => Promise<ConnectionResult>;
  channelsQqResolveAuthRequirement: (input: { listenMode: string; customHost?: string }) => Promise<QqListenAuthRequirement>;
  channelsQqBotTestConnection: () => Promise<ConnectionResult>;
  channelsLogGet: (limit?: number) => Promise<unknown[]>;
  channelsLogClear: () => Promise<{ ok: boolean }>;
  channelsContextBindingsGet: () => Promise<ContextBindingCatalog>;
  channelsContextBind: (payload: { sessionId: string; conversationId: string }) => Promise<Acknowledgement>;
  channelsContextUnbind: (sessionId: string) => Promise<Acknowledgement>;
  onChannelsInstallProgress: (callback: (progress: { channel: string; phase: string; pct: number }) => void) => (() => void) | void;
  onChannelsWechatQrcode: (callback: (dataUrl: string) => void) => (() => void) | void;
  onChannelsWechatLoginDone: (callback: (payload: { ok: boolean; botId?: string; error?: string }) => void) => (() => void) | void;
  channelsWechatLoginStart: () => Promise<Acknowledgement>;
  channelsGetStatus: () => Promise<Record<string, ChannelPhase>>;
  onChannelsStatusChanged: (callback: (status: unknown) => void) => (() => void) | void;
};
