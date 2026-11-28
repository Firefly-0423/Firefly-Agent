/**
 * Firefly 1.2.0 插件清单（firefly.plugin.json）的类型与取值表。
 * 纯 TypeScript，不引用 Electron 或 Node；宿主、SDK 命令行和测试共用这一份。
 */
import type { ToolRiskLevel } from "../permission-approval";

export const MANIFEST_FILE_NAME = "firefly.plugin.json";
export const MANIFEST_SCHEMA_VERSION = 1;

/** 插件工具可声明的风险：Firefly 的 ToolRiskLevel 去掉 safe（宿主无法核实插件自称的“无副作用”）。 */
export const PLUGIN_TOOL_RISKS = ["fs-read", "fs-write", "shell", "network", "input-control"] as const satisfies readonly Exclude<
  ToolRiskLevel,
  "safe"
>[];
export type PluginToolRisk = (typeof PLUGIN_TOOL_RISKS)[number];

/** 工具只在 Work / Code 模式挂载，Chat 模式不挂插件工具。 */
export const PLUGIN_TOOL_MODES = ["work", "code"] as const;
export type PluginToolMode = (typeof PLUGIN_TOOL_MODES)[number];

export const PLUGIN_CONTEXT_MODES = ["chat", "work", "code"] as const;
export type PluginContextMode = (typeof PLUGIN_CONTEXT_MODES)[number];

export const PLUGIN_RUN_SOURCES = ["user", "schedule", "plugin", "channel"] as const;
export type PluginRunSource = (typeof PLUGIN_RUN_SOURCES)[number];

export const PLUGIN_PERMISSIONS = [
  "model.generate",
  "model.run",
  "events",
  "sessions.read",
  "workspace.read",
  "schedules",
  "notifications",
  "secrets",
  "ui.windows",
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export const PLUGIN_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

export interface PluginManifestAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PluginManifestTool {
  name: string;
  title: string;
  risk: PluginToolRisk[];
  modes: PluginToolMode[];
}

export interface PluginManifestContext {
  id: string;
  title: string;
  modes: PluginContextMode[];
  sources: PluginRunSource[];
}

export interface PluginManifestChannel {
  id: string;
  title: string;
}

export interface PluginManifestSettingsPanel {
  entry: string;
  title: string;
}

export interface PluginManifestWindow {
  id: string;
  entry: string;
  title: string;
  width?: number;
  height?: number;
}

export interface PluginManifestUi {
  settings?: PluginManifestSettingsPanel;
  windows?: PluginManifestWindow[];
}

export interface PluginManifestV1 {
  schemaVersion: 1;
  /** 反向域名，如 dev.firefly.weather。 */
  id: string;
  name: string;
  /** SemVer。 */
  version: string;
  /** 插件要求的宿主版本范围，如 ^1.2.0。 */
  sdk: string;
  description?: string;
  author?: PluginManifestAuthor;
  license?: string;
  /** 包内相对路径，.mjs 或 .cjs。 */
  main: string;
  icon?: string;
  platforms?: PluginPlatform[];
  /** 包内含 .node / .dll 时必须为 true。 */
  native?: boolean;
  tools?: PluginManifestTool[];
  context?: PluginManifestContext[];
  channels?: PluginManifestChannel[];
  permissions?: PluginPermission[];
  ui?: PluginManifestUi;
}

/**
 * 每个对象类型的字段全集。`satisfies Record<keyof T, true>` 让类型增删字段时这里编译不过，
 * 校验器的“未知字段”判断和 JSON Schema 一致性测试都以它为准。
 */
export const MANIFEST_KEYS = {
  root: {
    schemaVersion: true,
    id: true,
    name: true,
    version: true,
    sdk: true,
    description: true,
    author: true,
    license: true,
    main: true,
    icon: true,
    platforms: true,
    native: true,
    tools: true,
    context: true,
    channels: true,
    permissions: true,
    ui: true,
  } satisfies Record<keyof PluginManifestV1, true>,
  author: { name: true, email: true, url: true } satisfies Record<keyof PluginManifestAuthor, true>,
  tool: { name: true, title: true, risk: true, modes: true } satisfies Record<keyof PluginManifestTool, true>,
  context: { id: true, title: true, modes: true, sources: true } satisfies Record<keyof PluginManifestContext, true>,
  channel: { id: true, title: true } satisfies Record<keyof PluginManifestChannel, true>,
  ui: { settings: true, windows: true } satisfies Record<keyof PluginManifestUi, true>,
  settings: { entry: true, title: true } satisfies Record<keyof PluginManifestSettingsPanel, true>,
  window: { id: true, entry: true, title: true, width: true, height: true } satisfies Record<keyof PluginManifestWindow, true>,
} as const;

/** 0.x 清单才有的顶层字段；出现即判定为 0.x 插件。 */
export const LEGACY_MANIFEST_KEYS = ["apiVersion", "entry", "deps", "hooks", "settingsPanel", "settingsSection", "defaultEnabled"] as const;

export type ManifestErrorCode =
  | "manifest_not_object"
  | "legacy_manifest"
  | "schema_version_unsupported"
  | "required"
  | "invalid_type"
  | "unknown_field"
  | "invalid_id"
  | "invalid_name"
  | "invalid_version"
  | "invalid_sdk_range"
  | "sdk_unsatisfied"
  | "risk_empty"
  | "risk_safe_forbidden"
  | "risk_invalid"
  | "modes_empty"
  | "mode_invalid"
  | "source_invalid"
  | "permission_invalid"
  | "platform_invalid"
  | "duplicate_id"
  | "invalid_path"
  | "invalid_value"
  // 以下由包边界检查（Node 侧）产生
  | "manifest_missing"
  | "manifest_json"
  | "path_absolute"
  | "path_traversal"
  | "path_symlink_escape"
  | "file_missing"
  | "main_extension"
  | "native_binary_undeclared"
  | "symlink_not_allowed";

export interface ManifestError {
  code: ManifestErrorCode;
  /** 出错字段的 JSON Pointer，根为空字符串，如 /tools/0/risk/1。 */
  path: string;
  message: string;
  /** 包边界错误才有：相对包根的文件路径，正斜杠。 */
  file?: string;
}
