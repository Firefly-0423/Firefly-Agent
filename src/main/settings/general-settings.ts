import type { ChatAppearanceSettings } from "../../shared/chat-appearance";
import type { LspServerOverride } from "../lsp/types";
import type { ProactiveChatMode, ProactiveDeliveryTarget } from "../../shared/preferences";
import type { SkillModeOverrides } from "../skills/types";
import type { ToolModeOverrides } from "../orchestrator/tools/registry/tool-registry";
import type { UiColors } from "../../shared/ui-colors";
import type { UiFont } from "../../shared/ui-font";
import type { UiIcon } from "../../shared/ui-icon";
import type { UiTheme } from "../../shared/ui-theme";

/**
 * 全局设置，与聊天外观字段合并后统一落盘到 general-settings.json。
 * 成员按字母顺序排列，仅为便于查找，不影响任何读写行为。
 */
export interface GeneralSettings extends ChatAppearanceSettings {
  amapKey: string;
  asrAliyunAccessKeyId: string;
  asrAliyunAccessKeySecret: string;
  asrAliyunAppKey: string;
  asrEngine: "off" | "aliyun" | "mossland" | "local";
  asrLanguage: "zh" | "en" | "auto";
  /** 桌面听写与渠道语音转写共用的凭据。 */
  asrMosslandKey: string;
  /** 社交上下文抽取，默认关闭，开启后每轮多一次异步抽取。 */
  chatSocialContextEnabled: boolean;
  chatToolsEnabled: boolean;
  /** 邮件发送插件开关。 */
  emailEnabled: boolean;
  emailFromName: string;
  emailSmtpHost: string;
  /** 465 通常为 SSL，587 通常为 STARTTLS。 */
  emailSmtpPort: number;
  /** 是否启用 SSL/TLS，可被用户覆盖。 */
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  /** SMTP 授权码，不是邮箱登录密码。 */
  emailSmtpPass: string;
  language: "zh-CN" | "en";
  launchAtLogin: boolean;
  /** Code 模式下用户自管的语言服务命令。 */
  lspServerOverrides: LspServerOverride[];
  /** 单次运行的工具轮次上限，0 为不限。 */
  maxParallelToolCalls: number;
  maxToolRounds: number;
  /** 音乐工具默认开启，保持升级前的可用行为。 */
  musicEnabled: boolean;
  /** 单次运行的时长上限（分钟，不计 ask_user 等待），0 为不限。 */
  runTimeoutMinutes: number;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  /** 桌宠缩放，默认 1.0，允许 0.5 至 2.0。 */
  petZoom: number;
  /** 桌宠窗口位置，未记录时为 undefined。 */
  petWindowX?: number;
  petWindowY?: number;
  /** Playwright MCP 浏览器自动化，默认关闭。 */
  playwrightMcpEnabled: boolean;
  /** 功能插件启停表，键为 pluginId。 */
  plugins: Record<string, boolean>;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  searchAnySearchKey: string;
  searchBochaKey: string;
  searchEngine: "off" | "bocha" | "tavily" | "minimax" | "anySearch";
  searchMinimaxKey: string;
  searchTavilyKey: string;
  /** Chat-mode replies shown as several bubbles (display only). */
  segmentedChatEnabled: boolean;
  sidebarVisible: boolean;
  /** Skill 按模式可见性覆盖，键为 skillId；覆盖优先于 skill 自身声明的 modes。 */
  skillModeOverrides: SkillModeOverrides;
  /** 提醒中心的声音开关，关闭后仅静音，弹窗照常。 */
  toastSoundEnabled: boolean;
  /** 工具按模式可见性覆盖，键为 toolId；覆盖优先于工具自身声明的 modes。 */
  toolModeOverrides: ToolModeOverrides;
  travelEnabled: boolean;
  /** 截图热键，Electron Accelerator 写法，例如 "Alt+Shift+S"。 */
  screenshotHotkey: string;
  uiColors: UiColors;
  uiFont: UiFont;
  uiIcon: UiIcon;
  uiTheme: UiTheme;
  weatherEnabled: boolean;
  /** 天气数据源：open-meteo 免配置，amap 需要密钥。 */
  weatherSource: "open-meteo" | "amap";
}
