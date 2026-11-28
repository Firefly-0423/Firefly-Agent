# Firefly 1.2.0 插件开发指南

本文面向插件开发者，完整说明 Firefly 1.2.0 插件的项目结构、`firefly.plugin.json` 逐字段规范、`ctx.*` 全部接口与协议错误码、#133 官方示例拆解，以及使用 `createTestHost()` 测试与 `firefly-plugin` CLI 打包的完整流程。安全模型与权限策略细节见 [plugin-authoring.md](./plugin-authoring.md)。

> **SDK 1.2.0 基线**：`@firefly_wu/plugin-sdk` **`1.2.0`**（`plugin-sdk/package.json`），对应清单 `schemaVersion: 1`（`firefly.plugin.json`）。本文涵盖工具、上下文、模型、事件、会话、工作区、定时任务、桌面通知（#136）、密钥与界面能力；**外部聊天渠道（`channels` / `ctx.channels`）：SDK 接口已提供，桌面接入随 1.2.x 提供**。

---

## 1. 安装 SDK 与包目录结构

```bash
npm install @firefly_wu/plugin-sdk
```

在本仓库源码下构建并本地安装 tarball：

```bash
pnpm run build:plugin-sdk
npm pack ./plugin-sdk
npm install /path/to/firefly_wu-plugin-sdk-1.2.0.tgz
```

一个标准的 1.2.0 插件包目录结构如下：

```text
my-plugin/
├── firefly.plugin.json   # 必填：1.2.0 插件清单
├── index.mjs             # 必填：main 指定的入口文件（.mjs 或 .cjs）
├── icon.png              # 可选：icon 字段声明的图标相对路径
└── ui/
    ├── settings.html     # 可选：ui.settings.entry 声明的设置面板
    └── radar.html        # 可选：ui.windows[].entry 声明的独立窗口
```

**包边界规则**（`src/plugins/v2/package/boundary.ts`）：
- `main`、`icon`、`ui.settings.entry`、`ui.windows[].entry` 必须为包根目录以内的相对路径，不允许 `..`、绝对路径、盘符、UNC 路径或指向包外的符号链接。
- 包内禁止任何符号链接或 Windows junction。
- `native` 不为 `true` 时，包内不得出现 `.node` 或 `.dll` 文件；且入口若运行在离线/第三方环境中，除 `@firefly_wu/plugin-sdk`（仅类型或随包携带的 ESM/CJS 运行时）外，第三方运行时依赖需随插件包一并打包（或通过 `node_modules` 随包分发且不含符号链接）。

---

## 2. 清单 `firefly.plugin.json` 逐字段说明

清单结构由 [manifest.schema.json](../../src/shared/plugin-manifest/manifest.schema.json) 与校验器（`src/shared/plugin-manifest/validate.ts`）共同约束。**所有对象均启用 `additionalProperties: false`**，任何未定义字段都会触发 `unknown_field` 错误。

### 2.1 顶层字段

| 字段 | 必填 | 类型 / 约束 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | **是** | 常量 `1` | 必须为数字 `1`；否则报 `schema_version_unsupported` |
| `id` | **是** | 字符串，6–64 字符，正则 `^[a-z0-9]+(\.[a-z0-9-]+){2,}$` | 反向域名唯一标识，例如 `dev.firefly.weather` |
| `name` | **是** | 非空白字符串 | 展示给用户的插件名称 |
| `version` | **是** | 合法 SemVer 字符串 | 如 `1.0.0`、`1.2.0-beta.1` |
| `sdk` | **是** | 合法 SemVer 范围字符串 | 插件要求的宿主版本范围，如 `^1.2.0`；宿主版本不满足时报 `sdk_unsatisfied` |
| `main` | **是** | 相对路径，必须以 `.mjs` 或 `.cjs` 结尾 | 插件入口模块路径 |
| `description` | 否 | 非空白字符串 | 插件简介 |
| `author` | 否 | 对象 `{ name, email?, url? }` | 存在时 `author.name` 必填且非空白；`email` / `url` 可选非空白 |
| `license` | 否 | 非空白字符串 | 许可证标识，如 `"MIT"` |
| `icon` | 否 | 相对路径（非空白字符串） | 包内图标文件路径 |
| `platforms` | 否 | 非空枚举数组：`"win32" \| "darwin" \| "linux"` | 限定支持的操作系统平台 |
| `native` | 否 | 布尔值 | 包含 `.node` / `.dll` 原生模块时必须为 `true`；线上目录禁止 `native: true` |
| `tools` | 否 | `ToolManifest[]` | 静态声明插件注册的全部工具，名称不可重复 |
| `context` | 否 | `ContextManifest[]` | 静态声明插件注册的全部上下文 Provider，id 不可重复 |
| `channels` | 否 | `ChannelManifest[]` | **SDK 接口已提供，桌面接入随 1.2.x 提供**；静态声明渠道适配器，id 不可重复 |
| `permissions` | 否 | `PluginPermission[]` | 允许的权限枚举见下表 |
| `ui` | 否 | `{ settings?, windows? }` | 声明设置面板与独立窗口 |

### 2.2 嵌套对象字段

- **`tools[]`**：
  - `name`（必填，非空白，数组内唯一）：工具名，运行时 `ctx.tools.register({ name })` 必须一致。
  - `title`（必填，非空白）：界面展示标题。
  - `risk`（必填，非空数组）：元素只能是 `"fs-read" | "fs-write" | "shell" | "network" | "input-control"`；**禁止 `"safe"`**（错误码 `risk_safe_forbidden`）。
  - `modes`（必填，非空数组）：元素只能是 `"work" | "code"`（Chat 模式不挂载插件工具）。
- **`context[]`**：
  - `id`（必填，非空白，数组内唯一）：Provider ID。
  - `title`（必填，非空白）：展示标题。
  - `modes`（必填，非空数组）：元素为 `"chat" | "work" | "code"`。
  - `sources`（必填，非空数组）：元素为 `"user" | "schedule" | "plugin" | "channel"`。
- **`channels[]`** *(SDK 接口已提供，桌面接入随 1.2.x 提供)*：
  - `id`（必填，非空白，数组内唯一）、`title`（必填，非空白）。
- **`permissions[]`**：
  - 枚举值：`"model.generate"`、`"model.run"`、`"events"`、`"sessions.read"`、`"workspace.read"`、`"schedules"`、`"notifications"`、`"secrets"`、`"ui.windows"`。
- **`ui.settings`**：
  - `entry`（必填，相对路径）、`title`（必填，非空白）。
- **`ui.windows[]`**：
  - `id`（必填，非空白，数组内唯一）、`entry`（必填，相对路径）、`title`（必填，非空白）、`width`（可选正整数 `>= 1`）、`height`（可选正整数 `>= 1`）。

> **0.x 遗留字段拒绝规则**：只要顶层出现 `apiVersion`、`entry`、`deps`、`hooks`、`settingsPanel`、`settingsSection`、`defaultEnabled` 中任一字段，校验器立即返回 `legacy_manifest`（`"这是 0.x 插件，1.2.0 不再支持"`）。

---

## 3. 插件入口与生命周期（`definePlugin`）

入口模块通过 `definePlugin` 导出 `activate(ctx)` 与可选的 `deactivate(reason)`：

```ts
import { definePlugin, type DeactivateReason, type PluginContext } from "@firefly_wu/plugin-sdk";

const disposables: Array<{ dispose(): void }> = [];

export default definePlugin({
  async activate(ctx: PluginContext) {
    // ctx.id, ctx.version, ctx.dataDir, ctx.signal, ctx.has(permission)
  },
  async deactivate(reason: DeactivateReason) {
    // reason: "disabled" | "quit" | "upgrade" | "fault"
    while (disposables.length > 0) disposables.pop()?.dispose();
  },
});
```

> **打包要求**：宿主用原生 `import()` 加载入口，不会注入 SDK，`firefly-plugin pack` 也不归档 `node_modules`。入口保留 `@firefly_wu/plugin-sdk` 的运行时导入（`definePlugin`、`PluginError` 等）会在加载时抛出 `ERR_MODULE_NOT_FOUND`。本文的 TypeScript 示例须先打包进入口：
> `node_modules/.bin/esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=my-plugin/index.mjs`，再执行 `firefly-plugin pack`。不需要运行时值时，可直接默认导出对象并只用 `import type`。

`PluginContext` 基础只读属性与方法：
- `ctx.id: string`、`ctx.version: string`、`ctx.dataDir: string`（插件私有持久化目录）、`ctx.signal: AbortSignal`（停用或异常退出时中止）。
- `ctx.has(permission: string): boolean`：检查权限是否已声明且当前仍处于授予状态（用户在设置页撤销权限后会变为 `false`）。

宿主向插件发起的生命周期 RPC 方法（`HostToPluginParams` / `HostToPluginResults`）：

| 协议方法 | 请求参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `activate` | `{ id, dataDir, main, version, permissions }` | `void` | 激活入口，超时上限 10 秒 |
| `deactivate` | `reason` 或 `{ reason }`（`"disabled" \| "quit" \| "upgrade" \| "fault"`） | `void` | 优雅停用，宽限窗口 5 秒 |

---

## 4. `ctx.*` 接口契约全览（对齐 `plugin-protocol.ts`）

以下参数、返回值、流式分片（`PluginToHostStreamChunks`）与错误码严格对应 [src/shared/plugin-protocol.ts](../../src/shared/plugin-protocol.ts) 的三张类型表与 `plugin-sdk/src/types.ts`。

### 4.1 `ctx.tools` — 工具注册与四态返回

| 方向 / 方法 | 参数类型 | 返回 / 行为 |
| --- | --- | --- |
| `ctx.tools.register(tool)` | `ToolDefinition<A>`: `{ name, description, parameters: JSONSchemaObject, describeApproval?(args), execute(args, call) }` | 触发 `tools.register` RPC；返回 `Disposable`（`dispose()` 触发 `tools.unregister`）。`name` 必须在清单 `tools` 中声明，否则报 `ERR_UNDECLARED` |
| `call.progress(message, percent?)` | `{ callId, message, percent? }` | 触发 `tools.progress` 通知宿主刷新执行进度 |
| `tool.describeApproval` *(Host → Plugin)* | `{ name, args }` | 返回 `{ summary, target? } \| null`（未实现时返回 `null`，由宿主使用默认文案） |
| `tool.execute` *(Host → Plugin)* | `{ name, args, callId, sessionId, mode: "work" \| "code", caller: "firefly" \| { partnerId, partnerName } }` | 返回 `ToolResult`（`succeeded` / `failed` / `unknown` / `not_executed`） |

注意事项：
- `parameters` 仅支持局部 `#/$defs/...` 与 `#/definitions/...` 引用（不可递归），`type: "object"`。
- 每次工具调用默认超时 **60,000 ms**；若插件进程在调用期间崩溃，宿主向模型返回 `{ status: "unknown", reason: "Plugin process exited during tool execution" }`。

### 4.2 `ctx.context` — 上下文 Provider

| 方向 / 方法 | 参数类型 | 返回值 |
| --- | --- | --- |
| `ctx.context.register(provider)` | `ContextProviderDefinition`: `{ id, modes: Mode[], sources: RunSource[], provide(req) }` | 触发 `context.register`，返回 `Disposable`（`dispose()` 触发 `context.unregister`）。`id`、`modes`、`sources` 必须为清单 `context` 声明的子集（否则 `ERR_UNDECLARED`） |
| `context.provide` *(Host → Plugin)* | `{ id, sessionId, mode: "chat" \| "work" \| "code", source: "user" \| "schedule" \| "plugin" \| "channel" }` | 返回 `{ heading, content } \| null` |

约束：单次 `provide` 超时 **1,500 ms**，单 Provider 最多保留 **16,000** 字符，所有 Provider 合计最多 **32,000** 字符，内容以外部数据边界标签包裹送入模型。

### 4.3 `ctx.channels` — 外部聊天渠道

> **状态说明**：**SDK 接口已提供，桌面接入随 1.2.x 提供**。插件侧 `ctx.channels` 与宿主服务 `createPluginChannelService`（`src/plugins/v2/channels/channel-service.ts`）已合入分支，当前桌面主应用尚未接入渠道设置面板与消息路由入口。

接口契约与协议方法：
- `ctx.channels.register(adapter: ChannelAdapter): Disposable`：触发 `channels.register`（`id` 必须在 `manifest.channels` 中声明，否则报 `ERR_UNDECLARED`；插件停用或 `dispose()` 时断开连接并取消进行中的会话运行）。
- `ChannelAdapter`：`{ id, start(host: ChannelHost, signal), stop(), send(msg: OutboundMessage, signal) -> Promise<{ externalMessageId }> }`。
- `ChannelHost` 回调：
  - `reportState(s: { state: "disconnected" | "connecting" | "connected" | "error", detail? })`（协议方法 `channels.reportState`）。
  - `deliver(msg: InboundMessage): Promise<{ accepted: boolean; sessionId?: string }>`（协议方法 `channels.deliver`；入站校验通过即入队并返回 `accepted: true` 与宿主生成的会话 `sessionId`）。
- 宿主向插件发起的 RPC：`channel.start` (`{ id }`)、`channel.stop` (`{ id }`，1,500 ms 超时)、`channel.send` (`{ id, message: OutboundMessage }`) → `{ externalMessageId: string }`（30,000 ms 超时；若消息已投递后发生超时、取消或插件进程崩溃，宿主记录为 `{ status: "unknown", reason }` 且**禁止自动重试**）。

规格 §6.4 / §7.4 安全与运行规则：
- **默认 Chat 模式**：所有渠道入站会话默认处于 **Chat** 模式，不挂载任何工具。
- **按会话开启 Work（仅放行 `fs-read`）**：宿主按 `(pluginId, channelId, chat)` 粒度允许用户为单个私聊/群/话题开启 **Work** 模式；开启后**仅放行风险全为 `fs-read` 的工具**，其余风险（`fs-write`、`shell`、`network`、`input-control`）的工具不进入工具目录且在分发时被拒绝（`ERR_PERMISSION`）。模式切换会中止该会话当前运行。
- **审批只在本机完成**：所有需要审批的操作只能通过 Firefly 本机审批界面完成（`approveLocally`），绝不接受外部聊天平台的“回复同意”等指令。
- **回复发出前先脱敏**：所有通过 `channel.send` 发出的文本（包括自动回复与宿主显式发送）都会先经过宿主 `redactOutbound` 脱敏，再交给渠道插件发送。
- **入站载荷与队列上限**：入站文本上限 **64,000** 字符；单条消息最多 **8** 个附件且总字节上限 **10 MiB**（仅接受 `Uint8Array` 数据与 `"image" | "audio" | "file" | "video"` 类型，拒绝 `url` 附件）；单会话排队上限 **20** 条（溢出报 `ERR_RATE_LIMITED`）；入站文本统一包在 `<external-data>` 不可信数据标记内送入模型。

### 4.4 `ctx.model` — 调用宿主模型与子代理

| 方法 | 所需权限 | 参数 | 返回 / 流式分片 |
| --- | --- | --- | --- |
| `ctx.model.generate(req)` | `"model.generate"` | `{ prompt, system?, maxOutputTokens?, schema?, signal? }` | `Promise<{ text: string; usage?: { inputTokens, outputTokens } }>` |
| `ctx.model.generateStream(req)` | `"model.generate"` | 同上（底层 `model.generate` 带 `stream: true`） | `AsyncIterable<{ delta: string }>` |
| `ctx.model.run(req)` | `"model.run"`（**含首次确认**） | `{ objective, mode: Mode, sessionId?, allowPartners?, signal? }` | `{ events: AsyncIterable<RunEvent>, result: Promise<{ runId, sessionId, reply }> }` |

- `model.run` 的运行受当前权限档位约束；1.2.0 里需要用户审批的工具操作会被直接拒绝（不弹审批框、不挂起、不放行），所以要写文件或执行命令的任务请改用插件自己的工具并走正常审批。默认不调用伙伴，传 `allowPartners: true` 才允许。
- `model.run` 的 `RunEvent` 分片类型：`run.started`、`text.delta`、`tool.started`、`tool.completed`、`run.ended`（协议底层最后附带 `{ type: "run.result", result }` 分片）。
- `generate` / `generateStream` / `run` 共享每分钟滑动窗口限频（默认 **10 次/分钟**，可配置 1–60，超限抛出 `ERR_RATE_LIMITED`，`retryable: true`）。
- 模型输出与流式分片均经宿主脱敏器处理。

### 4.5 `ctx.events` — 宿主事件订阅

- **权限**：`"events"`。
- **方法**：`ctx.events.on(type, fn): Disposable`（对应 `events.subscribe` 流）。
- **支持事件与载荷**：
  - `"run.started"`：`{ type, runId, sessionId, mode, source, at }`
  - `"run.ended"`：`{ type, runId, sessionId, outcome: "completed" \| "cancelled" \| "failed", at }`
  - `"tool.completed"`：`{ type, runId, tool, status: ToolResult["status"], durationMs, at }`
  - `"schedule.completed"`：`{ type, taskId, outcome: "completed" \| "cancelled" \| "failed", at }`
- 订阅仅包含脱敏后的元数据，单订阅队列上限 **100** 条（溢出丢弃最旧记录），撤销权限后以 `ERR_PERMISSION` 结束流。

### 4.6 `ctx.sessions` 与 `ctx.workspace` — 会话与工作区只读

| 接口 | 所需权限 | 参数 | 返回值 / 分片 |
| --- | --- | --- | --- |
| `ctx.sessions.list(o?)` | `"sessions.read"`（**首次确认**） | `{ cursor?, limit?, mode? }` | `Promise<Page<SessionSummary>>`（`{ items: [{ id, title, mode, updatedAt }], nextCursor? }`） |
| `ctx.sessions.messages(sessionId, o?)` | `"sessions.read"`（**首次确认**） | `sessionId`, `{ cursor?, limit? }` | `Promise<Page<MessageRecord>>`（`{ items: [{ id, role, content, createdAt }], nextCursor? }`） |
| `ctx.workspace.current(sessionId?)` | `"workspace.read"`（**首次确认**） | `sessionId?` | `Promise<{ sessionId, mode, root: string \| null, name: string \| null } \| null>` |
| `ctx.workspace.onChange(fn)` | `"workspace.read"`（**首次确认**） | `(info: WorkspaceInfo \| null) => void` | `Disposable`（`workspace.watch` 流） |

- `sessions.list` / `sessions.messages` 的 `limit` 范围为 **1–100**（默认 50），仅返回当前绑定工作区内的公开脱敏消息。

### 4.7 `ctx.schedules` — 定时任务提议与回调

所需权限：`"schedules"`。

| 方法 | 参数 | 返回值 / 流式分片 |
| --- | --- | --- |
| `propose(spec)` | `{ title, schedule: Schedule, action: ScheduleAction }` | `Promise<{ taskId: string; status: "pending_approval" }>` |
| `update(taskId, patch)` | `taskId`, `Partial<ScheduleProposalSpec>` | `Promise<{ status: "pending_approval" }>` |
| `remove(taskId)` | `taskId: string` | `Promise<boolean>` |
| `list()` | — | `Promise<TaskRecord[]>`（`status`: `"pending_approval" \| "active" \| "paused"`） |
| `onTrigger(fn)` | `(e: { taskId, payload?, signal }) => Promise<void>` | `Disposable`（对应 `schedules.onTrigger` 流，chunk 为 `{ taskId, payload? }`） |

- `Schedule` 支持三种形式：`{ kind: "cron", expression, timezone? }`、`{ kind: "once", at }`、`{ kind: "interval", minutes }`。
- `ScheduleAction` 支持 `{ type: "run", prompt, mode }` 或 `{ type: "callback", payload? }`（`payload` 须可 JSON 序列化）。

### 4.8 `ctx.notifications` — 桌面通知（#136）

所需权限：`"notifications"`（在启用插件时确认授予，无额外首次确认；未声明报 `ERR_UNDECLARED`，未授权或撤销后报 `ERR_PERMISSION`）。

| 方法 | 参数 | 返回值 |
| --- | --- | --- |
| `ctx.notifications.show(notification)` | `{ title: string; body: string }` | `Promise<{ shown: boolean }>`（协议方法 `notifications.show`） |

规则与约束（对齐 `src/shared/plugin-notifications.ts` 与 `src/plugins/v2/notifications/index.ts`）：
- **纯文本与精确字段**：入参必须为只含 `title` 和 `body` 两个字符串字段的对象（多余字段或非字符串报 `ERR_INVALID_ARGUMENT`）；不支持链接动作、按钮或自定义图标。
- **字符清洗与长度上限**：宿主清除所有控制字符（`[\p{Cc}\p{Cf}]`，含双向覆盖符）后统计 Unicode 码点，**`title` 上限 `64` 个码点、`body` 上限 `256` 个码点**；超限抛出 `ERR_INVALID_ARGUMENT`（不消耗限频配额）。
- **宿主插件名前缀与点击行为**：宿主自动在通知标题前加上已安装清单中的真实插件名 **`〔插件名〕`**；用户点击通知仅恢复并聚焦 Firefly 主窗口，不回调插件或解析 URL。
- **每分钟限频**：每插件每分钟滑动窗口最多 **`5` 次**（已授权且参数有效的调用即使系统不支持或显示失败也会计入配额；生命周期重启不重置配额），超限抛出 `ERR_RATE_LIMITED`（`retryable: true`）。
- **`{ shown: false }` 语义与资源释放**：当操作系统不支持通知、用户关闭通知开关、平台发送失败或 5 秒内未收到显示确认时返回 `{ shown: false }`；插件停用、撤权或升级时会关闭待显示通知并移除点击监听。

### 4.9 `ctx.secrets` — 加密凭据存储

所需权限：`"secrets"`。

| 方法 | 参数 | 返回值 |
| --- | --- | --- |
| `set(key, value)` | `key: string`, `value: string` | `Promise<void>` |
| `get(key)` | `key: string` | `Promise<string \| null>` |
| `delete(key)` | `key: string` | `Promise<boolean>` |
| `keys()` | — | `Promise<string[]>` |

底层基于 Electron `safeStorage` 加密；加密不可用时统一抛出 `ERR_UNAVAILABLE`。

### 4.10 `ctx.ui` — 设置面板与独立窗口

| 方法 | 权限要求 | 参数 | 返回值 / 行为 |
| --- | --- | --- | --- |
| `openWindow(id, state?)` | `"ui.windows"` + 清单 `ui.windows` 声明 | `id: string`, `state?: unknown` | `Promise<{ close(): Promise<void>, post(msg): Promise<void> }>`（对应 `ui.openWindow` / `ui.closeWindow` / `ui.post`） |
| `onMessage(fn)` | 清单声明 `ui.settings`、`ui.windows` 或 `"ui.windows"` | `(e: { from: UiTarget, method, params }) => Promise<unknown>` | `Disposable`（监听 `ui.onMessage` 流并响应 `ui.message` 请求） |
| `post(to, msg)` | 同上 | `to: { kind: "window" \| "settings", id }`, `msg: unknown` | `Promise<void>`（主动向面板或窗口推送消息） |

在插件的 `ui/settings.html` 或独立窗口页面脚本中，宿主注入受限桥 `window.fireflyPlugin`（例如 `await window.fireflyPlugin.invoke(method, params)`），可直接调用插件通过 `ctx.ui.onMessage` 注册的方法。

### 4.11 协议错误码一览（`PLUGIN_ERROR_CODES`）

`PluginError` 自带 `code: PluginErrorCode`、`message: string`、`retryable: boolean`（支持跨包边界 `instanceof PluginError`）：

| 错误码 | 典型含义 | 常见触发场景 |
| --- | --- | --- |
| `ERR_UNDECLARED` | 未在清单声明 | 调用未在 `permissions` 声明的能力；注册未在 `tools`/`context`/`channels`/`ui.windows` 声明的条目 |
| `ERR_PERMISSION` | 权限被拒绝或撤销 | 用户撤销权限（含 `notifications`）、拒绝首次调用确认、确认 120s 超时、或 `sessions.messages` 越权访问其他 `sessionId` |
| `ERR_REJECTED` | 被宿主或审批拒绝 | 工具审批被用户拒绝、或输入策略明确拒绝请求 |
| `ERR_CANCELLED` | 请求已取消 | `AbortSignal` 已中止、插件停用中、或用户点击「停止借用模型」 |
| `ERR_TIMEOUT` | 操作超时 | 进程激活超时（10s）、上下文收集超时（1.5s）、工具或模型调用超时（`retryable` 视调用而定） |
| `ERR_INVALID_ARGUMENT` | 参数校验失败 | RPC 入参多余未知字段、通知标题/正文超 64/256 码点、非法页码/limit、空 key、非法 JSON Schema |
| `ERR_RATE_LIMITED` | 触发限频 | `model.generate` / `model.run` 超每分钟配额、`notifications.show` 超 5 次/分钟、或渠道单会话队列超过 20 条（`retryable: true`） |
| `ERR_UNAVAILABLE` | 宿主服务或进程不可用 | 模型未配置、`safeStorage` 不可用、插件进程已退出、旧激活句柄失效、或上游网络临时不可用（网络错误 `retryable: true`） |
| `ERR_INTERNAL` | 内部错误 | 未预期的序列化、存储或内部异常 |

---

## 5. 官方示例插件参考（PR #133）

仓库 `plugin-sdk/examples/`（来自 PR #133）提供两个完整可运行的 1.2.0 示例插件：

1. **天气查询（`plugin-sdk/examples/dev.firefly.weather`）**：
   - 清单声明 `secrets` 权限、`network` 风险工具 `get_weather`（`modes: ["work", "code"]`）以及设置面板 `ui.settings`（`ui/settings.html` + `ui/settings.js`）。
   - 展示：入参校验失败先返回 `not_executed`（不触碰密钥或网络）、`ctx.secrets` 读写 API Key、超时/网络故障返回 `failed`（`retryable`）、取消返回 `not_executed`，以及设置页通过 `window.fireflyPlugin.invoke` 与 `ctx.ui.onMessage` 交互。
2. **定时提醒（`plugin-sdk/examples/dev.firefly.reminder`）**：
   - 清单声明 `schedules`、`model.generate` 与 `notifications` 权限，以及 `create_daily_reminder`（`fs-write`）和 `list_reminders`（`fs-read`）两个工具。
   - 展示：`ctx.schedules.propose` 创建 `pending_approval` 的每日 `callback` 任务、`ctx.schedules.onTrigger` 触发回调时二次检查 `status === "active"`、调用 `ctx.model.generate` 生成提醒文本，并通过 `ctx.notifications.show` 发送桌面通知（截断至 64/256 码点，处理 `{ shown: false }` 与撤权异常）。

下面是一个结合工具、上下文 Provider 与状态清理的完整可测插件与清单示例：

<!-- doc-example: manifest id=guide-notes -->
```json
{
  "schemaVersion": 1,
  "id": "dev.firefly.notes",
  "name": "随手记示例",
  "version": "1.0.0",
  "sdk": "^1.2.0",
  "description": "演示工具、上下文 Provider 与 secrets 协同工作。",
  "author": {
    "name": "Firefly-0423"
  },
  "license": "MIT",
  "main": "index.mjs",
  "native": false,
  "permissions": ["secrets", "events"],
  "tools": [
    {
      "name": "save_note",
      "title": "保存笔记",
      "risk": ["fs-write"],
      "modes": ["work", "code"]
    }
  ],
  "context": [
    {
      "id": "recent_note",
      "title": "最近笔记",
      "modes": ["chat", "work", "code"],
      "sources": ["user", "schedule"]
    }
  ]
}
```

<!-- doc-example: plugin id=guide-notes -->
```ts
import { definePlugin, type PluginContext } from "@firefly_wu/plugin-sdk";

export function createNotesPlugin() {
  const disposables: Array<{ dispose(): void }> = [];
  let lastNote = "";

  return definePlugin({
    activate(ctx: PluginContext) {
      disposables.push(
        ctx.tools.register({
          name: "save_note",
          description: "保存一条短笔记到内存与加密存储。",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1 },
            },
            required: ["text"],
            additionalProperties: false,
          },
          describeApproval(args) {
            return { summary: "保存一条短笔记", target: String(args.text ?? "").slice(0, 20) };
          },
          async execute(args, call) {
            if (call.signal.aborted) {
              return { status: "not_executed", reason: "已取消" };
            }
            const text = typeof args.text === "string" ? args.text.trim() : "";
            if (!text) {
              return { status: "not_executed", reason: "text 不能为空" };
            }
            if (!ctx.has("secrets")) {
              return { status: "failed", error: "缺少 secrets 权限", retryable: false };
            }
            await ctx.secrets.set("latest_note", text);
            lastNote = text;
            return { status: "succeeded", output: { saved: true, length: text.length }, summary: "已保存笔记" };
          },
        }),
      );

      disposables.push(
        ctx.context.register({
          id: "recent_note",
          modes: ["chat", "work", "code"],
          sources: ["user", "schedule"],
          async provide(req) {
            if (req.signal.aborted || !lastNote) return null;
            return { heading: "最近笔记", content: lastNote };
          },
        }),
      );
    },

    deactivate() {
      while (disposables.length > 0) disposables.pop()?.dispose();
    },
  });
}

export default createNotesPlugin();
```

---

## 6. 使用 `createTestHost()` 编写自动化测试

使用 `@firefly_wu/plugin-sdk/testing` 在无 Electron 环境下覆盖工具调用、上下文注入、权限档位与权限撤销：

<!-- doc-example: test id=guide-notes manifest=guide-notes plugin=guide-notes -->
```ts
import { expect } from "vitest";
import { createTestHost } from "@firefly_wu/plugin-sdk/testing";

export async function verifyGuideNotesPlugin(manifest: any, plugin: any) {
  const host = createTestHost({
    manifest,
    mode: "work",
    level: "per-action",
    approvalDecision: "allow",
  });

  await host.activate(plugin);

  // 未保存前上下文返回 null
  await expect(host.provideContext("recent_note", { mode: "work", source: "user" })).resolves.toBeNull();

  // 执行工具并校验 secrets 写入与上下文产出
  const res = await host.callTool("save_note", { text: "1.2.0 文档已完成" });
  expect(res.status).toBe("succeeded");
  expect(host.secrets.get("latest_note")).toBe("1.2.0 文档已完成");

  const provided = await host.provideContext("recent_note", { mode: "work", source: "user" });
  expect(provided).toEqual({ heading: "最近笔记", content: "1.2.0 文档已完成" });

  // 在 read-only 档位下，fs-write 工具被权限策略拒绝（not_executed）
  host.setLevel("read-only");
  await expect(host.callTool("save_note", { text: "应被拒绝" })).resolves.toMatchObject({
    status: "not_executed",
  });

  // 恢复 full 档位后撤销 secrets 权限，验证 failed 结果
  host.setLevel("full");
  host.revokePermission("secrets");
  await expect(host.callTool("save_note", { text: "无权限" })).resolves.toMatchObject({
    status: "failed",
    retryable: false,
  });

  await host.deactivate("disabled");
}
```

### 6.1 使用 `createTestHost()` 验证桌面通知与渠道适配器

以下可运行示例演示如何测试 `ctx.notifications.show`（含 `〔插件名〕` 前缀、`64`/`256` 字符限制、每分钟 `5` 次限频、`notificationsSupported: false` 返回 `{ shown: false }` 与撤权报错）以及 `ctx.channels.register` 适配器：

<!-- doc-example: manifest id=guide-notify-channel -->
```json
{
  "schemaVersion": 1,
  "id": "dev.firefly.notifier",
  "name": "通知与渠道示例",
  "version": "1.0.0",
  "sdk": "^1.2.0",
  "description": "演示桌面通知限额、shown: false 降级以及渠道适配器注册。",
  "author": {
    "name": "Firefly-0423"
  },
  "license": "MIT",
  "main": "index.mjs",
  "native": false,
  "permissions": ["notifications"],
  "tools": [
    {
      "name": "send_notice",
      "title": "发送桌面通知",
      "risk": ["fs-read"],
      "modes": ["work", "code"]
    }
  ],
  "channels": [
    {
      "id": "demo_bridge",
      "title": "演示渠道"
    }
  ]
}
```

<!-- doc-example: plugin id=guide-notify-channel -->
```ts
import { definePlugin, PluginError, type PluginContext } from "@firefly_wu/plugin-sdk";

export function createNotifyChannelPlugin() {
  const disposables: Array<{ dispose(): void }> = [];

  return definePlugin({
    activate(ctx: PluginContext) {
      disposables.push(
        ctx.tools.register({
          name: "send_notice",
          description: "发送一条纯文本桌面通知。",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "body"],
            additionalProperties: false,
          },
          async execute(args) {
            try {
              const res = await ctx.notifications.show({
                title: String(args.title ?? ""),
                body: String(args.body ?? ""),
              });
              return { status: "succeeded", output: res };
            } catch (err) {
              if (err instanceof PluginError) {
                return { status: "failed", error: err.code, retryable: err.retryable };
              }
              throw err;
            }
          },
        }),
      );

      disposables.push(
        ctx.channels.register({
          id: "demo_bridge",
          async start(chHost, signal) {
            chHost.reportState({ state: "connected" });
            if (!signal.aborted) {
              await chHost.deliver({
                externalMessageId: "ext-1",
                chat: { type: "private", id: "user-1" },
                sender: { id: "user-1", name: "Alice" },
                text: "你好，流萤",
                timestamp: 1000,
              });
            }
          },
          async stop() {},
          async send(msg) {
            return { externalMessageId: `sent:${msg.text}` };
          },
        }),
      );
    },
    async deactivate() {
      while (disposables.length > 0) disposables.pop()?.dispose();
    },
  });
}

export default createNotifyChannelPlugin();
```

<!-- doc-example: test id=guide-notify-channel manifest=guide-notify-channel plugin=guide-notify-channel -->
```ts
import { expect } from "vitest";
import { createTestHost } from "@firefly_wu/plugin-sdk/testing";

export async function verifyNotifyChannelPlugin(manifest: any, plugin: any) {
  // 1. 正常展示通知（宿主自动加 〔插件名〕 前缀）、校验 64/256 码点限制与 5 次/分钟限频
  const host = createTestHost({ manifest, mode: "work", level: "full" });
  await host.activate(plugin);

  await expect(host.callTool("send_notice", { title: "构建完成", body: "耗时 3 秒" })).resolves.toEqual({
    status: "succeeded",
    output: { shown: true },
  });
  expect(host.notifications[0]).toEqual({ title: "〔通知与渠道示例〕构建完成", body: "耗时 3 秒" });

  // 超过 64/256 码点限制抛出 ERR_INVALID_ARGUMENT，且不消耗配额
  await expect(host.callTool("send_notice", { title: "a".repeat(65), body: "ok" })).resolves.toEqual({
    status: "failed",
    error: "ERR_INVALID_ARGUMENT",
    retryable: false,
  });

  // 同一分钟内继续发送 4 条共达 5 条上限，第 6 条抛出 ERR_RATE_LIMITED
  for (let i = 0; i < 4; i++) {
    await expect(host.callTool("send_notice", { title: `第${i + 2}条`, body: "正常" })).resolves.toEqual({
      status: "succeeded",
      output: { shown: true },
    });
  }
  await expect(host.callTool("send_notice", { title: "超限", body: "第6条" })).resolves.toEqual({
    status: "failed",
    error: "ERR_RATE_LIMITED",
    retryable: true,
  });

  // 2. 驱动渠道适配器生命周期与消息收发
  await host.startChannel("demo_bridge");
  expect(host.channelStates.get("demo_bridge")).toEqual([{ state: "connected" }]);
  expect(host.deliveredMessages[0]?.message.text).toBe("你好，流萤");
  await expect(
    host.sendChannel("demo_bridge", { chat: { type: "private", id: "user-1" }, text: "已收到" }),
  ).resolves.toEqual({ externalMessageId: "sent:已收到" });
  await host.stopChannel("demo_bridge");

  // 撤销权限后报 ERR_PERMISSION
  host.revokePermission("notifications");
  await expect(host.callTool("send_notice", { title: "撤权", body: "应失败" })).resolves.toEqual({
    status: "failed",
    error: "ERR_PERMISSION",
    retryable: false,
  });
  await host.deactivate("disabled");

  // 3. 系统不支持或用户关闭通知时返回 { shown: false }
  const unsupportedHost = createTestHost({
    manifest: { ...manifest, id: "dev.firefly.notifier.off" },
    mode: "work",
    level: "full",
    notificationsSupported: false,
  });
  await unsupportedHost.activate(plugin);
  await expect(
    unsupportedHost.callTool("send_notice", { title: "静默降级", body: "系统关闭通知" }),
  ).resolves.toEqual({
    status: "succeeded",
    output: { shown: false },
  });
  expect(unsupportedHost.notifications).toEqual([]);
  await unsupportedHost.deactivate("disabled");
}
```

---

## 7. 校验、打包与安装 `.ffplugin`

1. **校验插件目录**：

```bash
npx firefly-plugin validate ./my-plugin --host-version 1.2.0
```

2. **打包为 `.ffplugin`（确定性 ZIP 归档）**：

```bash
npx firefly-plugin pack ./my-plugin -o ./dist/my-plugin-1.0.0.ffplugin
```

3. **在 Firefly 1.2.0 中导入与启用**：
   - 在设置页插件管理中导入生成的 `.ffplugin` 文件。
   - 新导入的插件默认为**停用**状态，须确认信任提示与权限列表后手动启用。
   - 启用后如涉及 `sessions.read`、`workspace.read`、`model.run`，会在首次调用时弹出单独确认框；在设置页撤销权限会立即生效。
