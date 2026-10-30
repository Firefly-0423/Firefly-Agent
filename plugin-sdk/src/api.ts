/**
 * Firefly 插件 API，第 1 版。
 *
 * 这份文件是面向插件作者的稳定契约，刻意不引用 src/main 与 src/shared：
 * 宿主内部怎么重构，都不应该改变第三方插件看到的类型。
 *
 * 文件按下面的顺序组织：版本与错误码、Manifest、工具、渠道、LLM、
 * 事件、宿主服务、提示词 Provider、插件入口。
 */

// ───────────────────────── 版本 ─────────────────────────

/** 本文件所描述的插件契约主版本号。 */
export const CURRENT_PLUGIN_API_VERSION = 1 as const;

// ───────────────────────── 错误码 ─────────────────────────

const HOST_ERROR_CODE_LIST = [
  "E_CAPABILITY_UNAVAILABLE",
  "E_INVALID_ARGUMENT",
  "E_NOT_FOUND",
  "E_NOT_OWNER",
  "E_STORAGE_UNAVAILABLE",
  "E_NO_ACTIVE_INPUT_TARGET",
  "E_PLUGIN_STOPPING",
  "E_INTERNAL",
] as const;

/**
 * 宿主服务对外暴露的稳定错误码。插件应当只根据 code 分支，
 * 不要去匹配 message 文案；宿主内部的异常细节只写宿主日志，不会传给插件。
 */
export type PluginHostErrorCode = (typeof HOST_ERROR_CODE_LIST)[number];

export interface PluginHostError extends Error {
  code: PluginHostErrorCode;
}

/** 上述错误码的运行时集合，测试里可直接拿来断言。 */
export const PLUGIN_HOST_ERROR_CODES: ReadonlySet<string> = new Set<string>(HOST_ERROR_CODE_LIST);

export function isPluginHostError(value: unknown): value is PluginHostError {
  if (!(value instanceof Error)) return false;
  return PLUGIN_HOST_ERROR_CODES.has((value as PluginHostError).code);
}

// ───────────────────────── Manifest ─────────────────────────

// 提示：下面这个类型和 PluginSettingsSection 的 JSDoc 会被写进 manifest.schema.json
// 的 description；改动文字后需要运行 npm run generate:plugin-schema 重新生成。

/**
 * 插件可向宿主申请的宿主服务。deps 只是服务可用性声明，不是安全权限：
 * 未声明的服务不会注入，声明的服务也只是获得该服务的稳定接口。
 */
export type PluginCapability = "channels" | "llm" | "secrets" | "workspace" | "conversations" | "scheduler";

/** 与 PluginCapability 对应的运行时数组，由 SDK 原样再导出。 */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  "channels", "llm", "secrets", "workspace", "conversations", "scheduler",
];

/**
 * 插件设置面板的挂载分区。每开放一个枚举值，设置页必须有对应的
 * 挂载容器，所以首版故意只收窄到渠道和插件两个分区。
 */
export type PluginSettingsSection =
  | "channels"
  | "plugins";

/** 宿主归一化之后的插件清单。 */
export interface PluginManifest {
  /** 全局唯一的小写 id，例如 "my-plugin"。 */
  id: string;
  /** 插件依赖的 API 主版本。 */
  apiVersion: number;
  /** 严格遵循 SemVer 的版本号。 */
  version: string;
  /** 向宿主申请的服务。这不是安全沙箱。 */
  deps?: PluginCapability[];
  name: string;
  description: string;
  author: string;
  /** 入口文件名，只能是插件目录内的裸文件名。 */
  entry: string;
  /** 图标文件名（png/jpg/webp/svg），同样必须是目录内的裸文件名，可省略。 */
  icon?: string;
  /** 设置面板的 HTML 文件名（插件目录内）；声明后宿主会把它挂到设置页。 */
  settingsPanel?: string;
  /** 面板所在的设置分区，缺省挂到「插件」分区。 */
  settingsSection?: PluginSettingsSection;
  /** 仅对随应用内置的插件生效；用户自己装的插件一律要手动启用。 */
  defaultEnabled: boolean;
}

/**
 * 插件作者提交的 manifest 原始形状，是 Manifest JSON Schema 的生成目标。
 * 与 PluginManifest 的区别：defaultEnabled 可省略（宿主归一化为 true），
 * 字段格式约束（id 连字符、SemVer、entry 裸文件名等）由加载器的文件
 * 与格式校验补充完成，Schema 只负责结构、类型和枚举。
 */
export interface PluginManifestInput {
  // 注意：字段的声明顺序会原样体现在生成的 Schema 里（properties 与 required 的顺序）。
  // 契约版本
  apiVersion: number;
  // 身份
  id: string;
  name: string;
  // 发布信息
  version: string;
  description: string;
  author: string;
  // 入口文件
  entry: string;
  // 以下均为可选字段：界面资源
  icon?: string;
  settingsPanel?: string;
  settingsSection?: PluginSettingsSection;
  // 启用策略与服务依赖
  defaultEnabled?: boolean;
  deps?: PluginCapability[];
}

// ───────────────────────── 工具 ─────────────────────────

/** 工具风险级，取值与宿主工具注册表里声明的风险级一致。 */
export type PluginToolRisk = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";

/** 工具执行结果被归一化后的状态，对应宿主执行层的四种 outcome。 */
export type PluginToolStatus = "success" | "failure" | "unknown" | "not_executed";

/** 工具参数所用的 JSON Schema 子集。 */
export type PluginJsonSchema = {
  /** JSON Schema 的类型名，例如 "string"、"object"。 */
  type: string;
  items?: PluginJsonSchema;
  properties?: Record<string, PluginJsonSchema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
  description?: string;
};

/** 工具执行时由宿主附带的上下文。 */
export interface PluginToolContext {
  /** 触发本次工具调用的用户原话。 */
  userQuery: string;
  /** 所属会话；没有会话归属的调用（例如定时任务）时缺省。 */
  conversationId?: string;
  runId?: string;
  /** 用户中止或超时时触发。 */
  signal?: AbortSignal;
  /** 已解析出的工作区根目录。 */
  resolvedWorkspaceRoot?: string;
  /** 当前会话模式。 */
  mode?: "chat" | "code" | "work";
  /** 本次调用适用的权限模式。 */
  permissionMode?: "normal" | "allow_all";
  /** 宿主附带的其他元数据，插件不应依赖其中的具体键。 */
  metadata?: Record<string, unknown>;
}

export interface PluginTool {
  /** 工具 id，必须以 `<插件id>_` 开头。 */
  id: string;
  /** 展示给用户和模型的名称。 */
  name: string;
  description: string;
  category?: string;
  capability?: string;
  catalogHint?: string;
  /** 调用参数的 Schema，顶层必须是 object。 */
  inputSchema: {
    type: "object";
    properties: Record<string, PluginJsonSchema>;
    required?: string[];
  };
  /** 声明工具是否需要宿主在调用 execute 时附带 ctx。 */
  needsContext?: boolean;
  execute(args: Record<string, unknown>, ctx?: PluginToolContext): Promise<string>;
  /** 工具当前是否启用。 */
  enabled: boolean;
  /** 标记该工具已弃用。 */
  deprecated?: boolean;
  /** 风险级，取值见 PluginToolRisk。 */
  risk?: PluginToolRisk;
  /** 仅在列出的会话模式下可用，缺省表示不限制。 */
  modes?: Array<"code" | "work">;
  /** 调用对外部世界造成的效果性质。 */
  effectKind?: "read" | "mutation" | "verification" | "external_side_effect" | "unknown";
  /** 执行之后是否需要宿主做产物或代码层面的验证。 */
  verificationPolicy?: "none" | "artifact" | "code" | "unknown";
  /** 结果在宿主账本中的记录方式；bypass 表示不缓存结果，相同参数每次都重新执行。 */
  ledgerPolicy?: "success_terminal" | "bypass";
}

/**
 * 工具完成事件：结果确定之后才发出的只读通知。
 * 不带工具参数、输出、文件改动内容和内部异常，只反映宿主视角的归一化结果。
 */
export interface PluginToolFinishedEvent extends PluginHostEventBase {
  /** 所属运行。 */
  runId: string;
  toolId: string;
  /** 本次调用的唯一标识，同一工具多次调用时用来区分。 */
  toolCallId: string;
  status: PluginToolStatus;
  risk: PluginToolRisk;
  durationMs?: number;
}

// ───────────────────────── 渠道 ─────────────────────────

/** 一个渠道支持的消息形态与长度上限。 */
export interface PluginChannelCapability {
  /** 单条文本的最大长度。 */
  maxTextLength: number;
  // 文本类
  text: boolean;
  markdown: boolean;
  // 富交互类
  card: boolean;
  sticker: boolean;
  // 媒体类
  image: boolean;
  audio: boolean;
  video: boolean;
  file: boolean;
}

export interface PluginChannelStatus {
  /** 渠道是否已被用户启用。 */
  enabled: boolean;
  /** 运行阶段：正常、离线、启动中、缺少配置、出错。 */
  phase: "running" | "offline" | "starting" | "config_missing" | "error";
  /** 面向用户的补充说明，例如出错原因。 */
  message?: string;
}

/** 收到的消息所带的附件。 */
interface PluginChannelAttachment {
  /** 附件种类。 */
  kind: "image" | "audio" | "file" | "video";
  /** 远程地址与本地路径二选一，视渠道而定。 */
  url?: string;
  filePath?: string;
  mime?: string;
  /** 附件的文字说明。 */
  caption?: string;
}

/** 渠道收到的一条消息。 */
export interface PluginIncomingMessage {
  /** 渠道 id。 */
  channel: string;
  /** 会话（私聊或群）在渠道内的 id。 */
  chatId: string;
  chatType?: "private" | "group";
  /** 话题或线程 id，渠道不支持时缺省。 */
  threadId?: string;
  messageId?: string;
  /** 发送者在渠道内的 id。 */
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: PluginChannelAttachment[];
  /** 消息产生的时间。 */
  at: Date;
  /** 渠道原始载荷，仅供调试，格式不作承诺。 */
  _raw?: unknown;
}

/** 要通过渠道发出的一条消息。 */
export interface PluginOutgoingMessage {
  /** 渠道 id。 */
  channel: string;
  /** 目标会话（私聊或群）在渠道内的 id。 */
  targetId: string;
  chatType?: "private" | "group";
  /** 话题或线程 id。 */
  threadId?: string;
  /** 消息内容，按 part 拼接；每个 part 至少带 kind。 */
  parts: Array<Record<string, unknown> & { kind: string }>;
}

/** 渠道收到消息后的回调；返回 null 表示不回复。 */
export type PluginMessageHandler = (
  message: PluginIncomingMessage,
) => Promise<PluginOutgoingMessage | null>;

export interface PluginChannelAdapter {
  /** 渠道 id。 */
  readonly id: string;
  /** 展示给用户的渠道名。 */
  readonly displayName: string;
  readonly capability: PluginChannelCapability;
  /** 由宿主在 start 之前接入，渠道收到消息时调用。 */
  onMessage: PluginMessageHandler | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: PluginOutgoingMessage): Promise<{ ok: boolean; error?: string }>;
  getStatus(): PluginChannelStatus;
}

// ───────────────────────── LLM 与无头目标运行 ─────────────────────────

export interface PluginLlmMessage {
  /** 消息角色。 */
  role: "system" | "user" | "assistant";
  /** 纯文本内容。 */
  content: string;
}

export interface PluginLlmGenerateOptions {
  /** 取值 1 到 8192，默认 1024。 */
  maxTokens?: number;
  /** 取值 1000 到 300000 毫秒；默认沿用当前聊天超时，但最多 120 秒。 */
  timeoutMs?: number;
  /** 插件自己持有的取消信号。 */
  signal?: AbortSignal;
  /** 简短的诊断标签，会拼在 plugin:<id> 之后。 */
  purpose?: string;
}

/** 无头目标运行对外公开的进度事件；不透出宿主 Harness 的内部事件结构。 */
export type PluginAgentEvent =
  | { kind: "tool_finished"; toolName: string; ok: boolean }
  | { kind: "tool_started"; toolName: string }
  | { kind: "round_started"; round: number };

export interface PluginAgentRunOptions {
  /** 由插件在启动前生成，宿主、工具上下文和日志都用这同一个 id。 */
  runId: string;
  /** 要完成的目标，会作为第一条 user 消息。 */
  goal: string;
  /** 本次运行专用的冻结工具集，不经过注册，直接复用 PluginTool 的完整契约。 */
  tools: ReadonlyArray<PluginTool>;
  /** 可选的诊断标签；宿主据此把这次运行和工具上下文标记为 plugin:<id>:<purpose>。 */
  purpose?: string;
  /** 插件自己持有的取消信号。 */
  signal?: AbortSignal;
  /** 进度事件回调；回调里不能再发起工具调用。 */
  onEvent?: (event: PluginAgentEvent) => void;
  /** 工具轮数上限，默认 50。 */
  maxRounds?: number;
  /** 整次运行的硬性截止时间（毫秒），默认 15 分钟。 */
  maxWallMs?: number;
}

export interface PluginAgentRunResult {
  /** 运行结束时模型给出的最终文本。 */
  text: string;
  /** 实际用掉的工具轮数。 */
  rounds: number;
  terminal: {
    status: PluginTurnStatus;
    /** 非成功终态时的原因说明。 */
    reason?: string;
    /** 终止后已发出的外部副作用是否仍可能继续生效。 */
    externalEffectsMayContinue: boolean;
  };
}

export interface PluginLlmService {
  generateText(
    messages: PluginLlmMessage[],
    options?: PluginLlmGenerateOptions,
  ): Promise<string>;
  /**
   * 新版宿主才有的无头目标循环。旧版宿主没有这个方法，
   * 插件需要自己准备兼容的回退路径。
   */
  runGoal?(options: PluginAgentRunOptions): Promise<PluginAgentRunResult>;
}

// ───────────────────────── 事件 ─────────────────────────

/** 轮次的统一终态：成功、用户取消、超时、运行错误四选一，互斥。 */
export type PluginTurnStatus = "success" | "cancelled" | "timeout" | "runtime_error";

/** 所有宿主事件共有的元数据。eventId 只用于排查关联，不保证恰好投递一次。 */
export interface PluginHostEventBase {
  /** 事件唯一标识，用于排查关联。 */
  eventId: string;
  /** 事件产生时间，ISO 字符串。 */
  timestamp: string;
}

export type PluginEventListener<T = unknown> = (payload: T) => void | Promise<void>;

export interface PluginEvents {
  /** 订阅事件，名称需带完整命名空间：host:* 或 plugin:<id>:*。 */
  on<T = unknown>(event: string, listener: PluginEventListener<T>): () => void;
  /** 发布本插件自己的事件，框架会把名称补全成 plugin:<id>:<event>。 */
  emit<T = unknown>(event: string, payload: T): Promise<void>;
}

/** host:turn:completed 的公开载荷：只有稳定的元数据，不含对话原文。 */
export interface PluginTurnCompletedEvent {
  /** 轮次来自桌面端还是外部渠道。 */
  source: "desktop" | "channel";
  mode: PluginPromptMode;
  conversationId: string;
  /** 来自渠道时的渠道 id。 */
  channel?: string;
  runId?: string;
}

interface PluginTurnEventBase extends PluginHostEventBase {
  runId: string;
  mode: PluginPromptMode;
}

// 轮次事件按 source 区分来源。三种来源各自的必填字段在这里定义一次，
// 开始与结束事件共用，插件按 source 分支后 TypeScript 会自动收窄。
type DesktopTurnOrigin = {
  source: "desktop";
  conversationId: string;
  inputMessageId: string;
};
type ChannelTurnOrigin = {
  source: "channel";
  channel: string;
  conversationId?: string;
};
type SchedulerTurnOrigin = {
  source: "scheduler";
  taskId: string;
  schedulerRunId: string;
};

/** 轮次开始事件。 */
export type PluginTurnStartedEvent = PluginTurnEventBase &
  (DesktopTurnOrigin | ChannelTurnOrigin | SchedulerTurnOrigin);

interface PluginTurnFinishedBase extends PluginTurnEventBase {
  status: PluginTurnStatus;
  /** 本轮耗时（毫秒）。 */
  durationMs?: number;
}

/**
 * 轮次结束事件。finalMessageId 只有在宿主确认本轮最终的 assistant 消息
 * 已经落盘之后才会出现；非成功的终态不能拿"当前最后一条 assistant 消息"
 * 来顶替这个字段。
 */
export type PluginTurnFinishedEvent = PluginTurnFinishedBase &
  (
    | (DesktopTurnOrigin & { finalMessageId?: string })
    | ChannelTurnOrigin
    | SchedulerTurnOrigin
  );

/**
 * 定时任务结束事件：带任务 id 和历史记录 id，方便插件把轮次事件与任务执行对上号。
 * 只含稳定元数据，不含任务提示词和模型输出。
 */
export interface PluginSchedulerFinishedEvent extends PluginHostEventBase {
  /** 任务 id。 */
  taskId: string;
  /** 对应的历史记录 id。 */
  schedulerRunId: string;
  status: PluginTurnStatus;
  /** 本次执行耗时（毫秒）。 */
  durationMs?: number;
}

// ───────────────────────── 宿主服务：会话 ─────────────────────────

/** 会话列表项的稳定投影，不暴露内部索引与存储细节。 */
export interface PluginConversationSummary {
  id: string;
  title: string;
  /** 会话所处的模式。 */
  mode: PluginPromptMode;
  /** 创建时间，ISO 字符串。 */
  createdAt: string;
  /** 最近更新时间，ISO 字符串。 */
  updatedAt: string;
}

/** 会话消息的稳定投影：角色只有 user 与 assistant，内容只有纯文本。 */
export interface PluginConversationMessage {
  id: string;
  /** 发言方。 */
  role: "user" | "assistant";
  /** 纯文本内容。 */
  text: string;
  /** 消息时间，ISO 字符串。 */
  at: string;
}

export interface PluginConversationListInput {
  /** 上一页返回的 nextCursor。 */
  cursor?: string;
  /** 每页条数，宿主可能收窄。 */
  limit?: number;
}

export interface PluginConversationPage {
  items: PluginConversationSummary[];
  /** 还有下一页时给出，作为下一次请求的 cursor。 */
  nextCursor?: string;
}

export interface PluginMessagePageInput {
  /** 要读取的会话。 */
  conversationId: string;
  /** 上一页返回的 nextCursor；边界已编码在游标里，无需重复传。 */
  cursor?: string;
  /** 每页条数，宿主可能收窄。 */
  limit?: number;
  /** 起点消息（含）。与 throughMessageId 搭配可以把读取范围固定下来。 */
  fromMessageId?: string;
  /** 终点消息（含）。翻页时不会越过它。 */
  throughMessageId?: string;
}

export interface PluginMessagePage {
  items: PluginConversationMessage[];
  /** 还有下一页时给出，作为下一次请求的 cursor。 */
  nextCursor?: string;
  /** 这次分页实际生效的边界（均为包含式）；后续页的游标沿用同一组边界。 */
  range: {
    fromMessageId?: string;
    throughMessageId?: string;
  };
}

/**
 * 只读的会话服务。长期记忆类插件的标准做法：把桌面轮次结束事件里的
 * inputMessageId / finalMessageId 当作 fromMessageId / throughMessageId
 * 传给 getMessages()，范围一旦固定，翻页就不会读到之后轮次的消息。
 */
export interface PluginConversationsService {
  list(input?: PluginConversationListInput): Promise<PluginConversationPage>;
  getMessages(input: PluginMessagePageInput): Promise<PluginMessagePage>;
}

// ───────────────────────── 宿主服务：密钥与工作区 ─────────────────────────

/**
 * 插件私有的密钥服务。key 在插件自己的命名空间里解析，读写不到其他插件的密钥；
 * 密钥只存放在宿主的安全存储中，卸载插件后默认仍然保留。
 */
export interface PluginSecretsService {
  /** 读取；不存在时返回 undefined。 */
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** 删除；返回是否真的删掉了一项。 */
  delete(key: string): Promise<boolean>;
}

/** 会话与工作区绑定关系的稳定投影。 */
export interface PluginWorkspaceBinding {
  conversationId: string;
  /** 工作区根目录的绝对路径。 */
  root: string;
  /** 展示用的目录名。 */
  displayName: string;
}

/**
 * 受限的工作区访问：只能读取会话已经绑定的工作区信息，
 * 没有绑定、解绑或选择目录的写入口。
 */
export interface PluginWorkspaceService {
  getBinding(conversationId: string): Promise<PluginWorkspaceBinding | null>;
}

// ───────────────────────── 宿主服务：定时任务 ─────────────────────────

/** 任务计划：一次性、每日、每周（0 表示周日）或固定间隔。 */
export type PluginScheduleConfig =
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  | { kind: "weekly"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; timeOfDay: string }
  | { kind: "daily"; timeOfDay: string }
  | { kind: "once"; runAt: string };

/**
 * 完整的执行规格：计划、提示词、会话模式、工具白名单合起来决定任务做什么，
 * 也是计算用户授权指纹的输入。以后若新增会影响行为的字段，必须先纳入这个规格；
 * 标题之类的展示信息不算执行规格。
 */
export interface PluginScheduledExecutionSpec {
  /** 什么时候触发。 */
  schedule: PluginScheduleConfig;
  /** 触发时交给模型的提示词。 */
  prompt: string;
  /** 以哪种会话模式运行。 */
  mode: PluginPromptMode;
  /** 明确列出的工具白名单；插件创建的任务不允许使用"全部启用"模式。 */
  allowedToolIds: string[];
}

export interface PluginScheduledTaskInput extends PluginScheduledExecutionSpec {
  /** 任务标题，只用于展示，修改它不会撤销授权。 */
  title: string;
}

/** 更新任务时的补丁：所有字段都可以省略。 */
export type PluginScheduledTaskPatch = Partial<PluginScheduledTaskInput>;

export interface PluginScheduledTask extends PluginScheduledTaskInput {
  id: string;
  /** 宿主算出的实际启用状态。插件不能写入它，创建后必须由用户在宿主界面确认启用。 */
  enabled: boolean;
  /** 下一次触发时间，ISO 字符串；已停用或不会再触发时为 null。 */
  nextFireAt: string | null;
  /** 最近一次触发时间，从未触发过则缺省。 */
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 任务执行历史的摘要：只留排查用的信息，不含完整的模型输出。 */
export interface PluginScheduledTaskHistory {
  /** 历史记录 id。 */
  id: string;
  /** 所属任务 id。 */
  taskId: string;
  /** 执行状态，取值由宿主定义。 */
  status: string;
  startedAt: string;
  /** 仍在执行时缺省。 */
  finishedAt?: string;
  /** 简短的结果摘要。 */
  summary?: string;
}

/**
 * 插件的定时任务服务。插件只能查看、修改自己创建的任务；这里没有启用、
 * 立即运行、切换到"全部工具"模式的接口，任何执行规格的变动都会
 * 撤销用户已经给出的授权并让任务回到停用状态。
 */
export interface PluginSchedulerService {
  listTasks(): Promise<PluginScheduledTask[]>;
  getHistory(id: string, limit?: number): Promise<PluginScheduledTaskHistory[]>;
  createTask(input: PluginScheduledTaskInput): Promise<PluginScheduledTask>;
  updateTask(id: string, patch: PluginScheduledTaskPatch): Promise<PluginScheduledTask>;
  deleteTask(id: string): Promise<boolean>;
}

// ───────────────────────── 提示词 Provider ─────────────────────────

export type PluginPromptMode = "chat" | "work" | "code";

/**
 * 提示词 Provider 可以参与的场景。新增场景默认不会套用到已有的 Provider，
 * 插件必须在 sources 里显式列出才会参与，免得升级后被悄悄扩大调用范围。
 */
export type PluginPromptSource = "conversation" | "scheduler" | "plugin-agent";

/** 各场景共有的构建输入：本轮用户文本、会话归属和当前模式。 */
interface PluginPromptBuildInputCommon {
  /** 本轮用户输入的文本。 */
  userText: string;
  conversationId?: string;
  channel?: string;
  mode: PluginPromptMode;
}

/** 用户会话轮次；mode 是当前会话的模式。 */
export interface ConversationPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "conversation";
}

/** 定时任务轮次；mode 是任务冻结下来的执行模式。 */
export interface SchedulerPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "scheduler";
}

/** 插件发起的无头目标循环；只有显式声明了该来源的 Provider 才会参与。 */
export interface PluginAgentPromptBuildInput extends PluginPromptBuildInputCommon {
  source: "plugin-agent";
}

/** Provider 拿到的构建输入，每个保留场景都带有会话模式。 */
export type PluginPromptBuildInput =
  | ConversationPromptBuildInput
  | SchedulerPromptBuildInput
  | PluginAgentPromptBuildInput;

/**
 * 接口不能 extends 联合类型，所以这里用交叉类型：它会分配到联合的每个成员上，
 * 按 source 收窄的效果与逐个成员声明完全一致。
 */
export type PluginPromptProviderInput = PluginPromptBuildInput & {
  /** 插件停止时触发；Provider 应尽快收尾仍在进行的异步工作。 */
  readonly signal: AbortSignal;
};

export interface PluginPromptProvider {
  /** 在当前插件内唯一；框架会自动补上 plugin:<插件id>: 前缀。 */
  id: string;
  /** 省略表示适用于所有会话模式。 */
  modes?: PluginPromptMode[];
  /**
   * 声明后只在列出的场景生效；省略时仅作用于 conversation 与 scheduler
   * （保持旧版行为），想参与 plugin-agent 必须显式写出。
   */
  sources?: PluginPromptSource[];
  /** 返回要追加的文本；返回空串表示本轮不追加。 */
  provide(input: PluginPromptProviderInput): string | Promise<string>;
}

// ───────────────────────── 插件入口 ─────────────────────────

export interface PluginStorage {
  /** 读取；不存在时返回 undefined。 */
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  /** 插件私有数据目录的绝对路径。 */
  rootDir(): string;
}

/** 宿主注入给插件的服务集合；没有在 manifest.deps 里声明的服务不会出现。 */
export interface PluginDeps {
  /** 只读的渠道发现；注册渠道必须走 PluginContext 上的方法。 */
  channels?: { has(id: string): boolean };
  /** 大模型文本生成与无头目标运行。 */
  llm?: PluginLlmService;
  /** 只读的会话与消息读取。 */
  conversations?: PluginConversationsService;
  /** 插件私有密钥。 */
  secrets?: PluginSecretsService;
  /** 受限的工作区信息读取。 */
  workspace?: PluginWorkspaceService;
  /** 插件自己的定时任务管理。 */
  scheduler?: PluginSchedulerService;
}

export type PluginCleanup = () => void | Promise<void>;

export interface PluginContext {
  /** 当前插件的 id。 */
  id: string;
  /** 插件停止、或激活失败开始回滚之前，会先触发这个取消信号。 */
  readonly signal: AbortSignal;
  /** 插件私有的键值存储。 */
  storage: PluginStorage;
  /** 已注入的宿主服务。 */
  deps: PluginDeps;
  /** 事件订阅与发布。 */
  events: PluginEvents;
  /** 写入宿主日志。 */
  log(...args: unknown[]): void;
  /** 登记本插件自有资源的清理回调；回调按登记的逆序执行，且各最多执行一次。 */
  onDispose(cleanup: PluginCleanup): void;
  registerTool(tool: PluginTool): void;
  unregisterTool(toolId: string): void;
  /** 注册每轮的动态提示词；内容进入 runtime context，不会改动核心提示词文件。 */
  registerPromptProvider(provider: PluginPromptProvider): void;
  unregisterPromptProvider(providerId: string): void;
  /** channel 名会自动加上 plugin:<id>:<channel> 的命名空间。 */
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  /** 接入一个消息渠道。 */
  registerChannelAdapter(adapter: PluginChannelAdapter): Promise<void>;
  unregisterChannelAdapter(channelId: string): Promise<void>;
}

/** 插件入口模块需要导出的对象。 */
export interface FireflyPlugin {
  /** 可选：用户在插件面板点击「打开」时调用，用来打开插件自己的窗口。 */
  open?(): void | Promise<void>;
  register(ctx: PluginContext): void | Promise<void>;
  /** 可选：插件停止时调用的收尾钩子。 */
  unregister?(): void | Promise<void>;
}
