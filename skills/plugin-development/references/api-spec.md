# 插件 API v1 参考

本文件适用于 `apiVersion: 1`。权威定义是宿主的 `src/plugins/api.ts`；SDK 中的 `packages/plugin-sdk/src/api.ts` 与它逐字一致。清单校验、加载与生命周期分别由 `src/plugins/manifest-validation.ts`、`loader.ts` 与 `manager.ts` 实现。

## 1. 版本与总览

- `CURRENT_PLUGIN_API_VERSION` 为 `1`。
- 宿主服务（deps）可选值：`channels`、`llm`、`secrets`、`workspace`、`conversations`、`scheduler`。
- 宿主服务的错误码共 8 个，见第 11 节。

## 2. manifest.json

### 示例

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明插件的用途",
  "author": "开发者名称",
  "entry": "index.cjs",
  "icon": "icon.png",
  "settingsPanel": "panel.html",
  "settingsSection": "plugins",
  "deps": ["llm", "secrets"]
}
```

### 字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `apiVersion` | number | 是 | 必须等于 `1` |
| `id` | string | 是 | 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`。决定安装目录名、工具前缀与 IPC 前缀，也是设置面板地址的主机名 |
| `name` | string | 是 | 去掉首尾空白后不能为空 |
| `version` | string | 是 | 标准 SemVer 2.0，允许预发布与构建元数据，例如 `2.0.0-beta.1`、`1.0.0+build.7` |
| `description` | string | 是 | 字符串。加载器会去掉首尾空白，但不拒绝空字符串 |
| `author` | string | 是 | 同上。卡片上显示为“开发者：……”，为空时显示“未知开发者” |
| `entry` | string | 是 | 插件目录内的裸文件名，扩展名为 `.cjs`、`.js` 或 `.mjs`。必须是普通文件，真实路径不能经由链接指到目录外 |
| `icon` | string | 否 | 裸文件名，扩展名为 `.png`、`.jpg`、`.jpeg`、`.webp` 或 `.svg`，大小不超过 2 MiB。无效时静默忽略，卡片显示默认图标 |
| `settingsPanel` | string | 否 | 裸文件名，扩展名为 `.html`，必须是普通文件，大小不超过 1 MiB。无效时静默忽略，同时丢弃 `settingsSection` |
| `settingsSection` | string | 否 | `channels` 或 `plugins`，缺省为 `plugins` |
| `defaultEnabled` | boolean | 否 | 只对内置插件生效；用户插件首次被发现时一律停用 |
| `deps` | string[] | 否 | 只能取 `channels`、`llm`、`secrets`、`workspace`、`conversations`、`scheduler`。未知值（包括拼写错误）会让整个 manifest 失败 |

清单 Schema 禁止未知字段，类型不符同样会导致失败。

### 两层校验

1. **结构层**：JSON Schema（`manifest.schema.json`，宿主与 SDK 共用），检查类型、必填项、枚举与未知字段。
2. **格式层**：加载器检查 `apiVersion` 是否等于 1、`id` 的格式、SemVer、`entry` 的裸文件名与扩展名、文件存在性与链接越界，以及图标和面板的“软失败”规则。

SDK 的 `validateManifestData()` 与 `assertValidManifest()` 只做结构层检查，不检查 id、SemVer、入口文件或 apiVersion。

### 启用前即失败的情况

- 缺少 `manifest.json`，或它不是合法的 JSON。
- 缺少必填字段、字段类型错误、出现未知字段，或 `deps` 含未知值。
- `apiVersion` 不等于 1。
- `id`、`version` 或 `entry` 不合格；入口文件不存在，或经符号链接指到插件目录之外。

## 3. 入口模块

```js
module.exports = {
  async register(ctx) { /* 必须：启用时调用 */ },
  async unregister() { /* 可选：停用、刷新、卸载、应用退出，或激活失败回滚时调用；需可重复调用 */ },
  async open() { /* 可选：实现后卡片上出现“打开”按钮 */ },
};
```

- 推荐使用 CommonJS（`.cjs`）。ESM 也可以，加载器取 `mod.default ?? mod`，结果必须含有 `register` 函数，否则报错“入口未导出 register()”。
- `register` 与 `open` 都可以是异步函数。
- 入口同时导出 `default` 也是允许的，示例 `system-status` 就是这样做的。

## 4. 生命周期

状态取值为 `disabled`、`starting`、`running`、`stopping`、`failed`。

```text
扫描到用户插件 -> disabled（首次发现一律停用）
启用 -> starting（加载入口、创建 ctx、调用 register）-> running
激活出错或超过 10 秒 -> failed（卡片显示错误，并出现“重试”）
停用 -> stopping -> disabled
```

- 激活（加载入口加上 `register`）的上限是 10 秒。超时即失败，并回滚已经登记的资源。
- 停用的顺序：`ctx.signal` 先被取消；然后调用插件的 `unregister()`（上限 5 秒）；最后按登记的逆序释放 ctx 登记的全部资源，每项上限 5 秒。`ctx.onDispose` 回调属于最后这一步，所以 `unregister()` 里清空的状态在 `onDispose` 中已经不可用。
- 应用退出时，先发布 `host:plugins:stopping` 并逐个等待监听器完成，然后依次停用所有运行中的插件。
- “刷新插件”会停用全部运行中的插件，重新扫描目录，清除 CommonJS 缓存，然后按启停设置重新启用。扫描时若某插件的 manifest 或入口文件内容发生变化，该插件会自动重载。
- 启用、停用、打开、刷新、安装、卸载与停止都进入同一个串行队列，不会并发注册。
- 卡片同时区分两个概念：`configuredEnabled`（用户是否希望启用）与 `status`（实际运行状态）。

## 5. ctx 对象

| 成员 | 说明 |
| --- | --- |
| `ctx.id` | 插件 id |
| `ctx.signal` | `AbortSignal`。停止开始时（先于 `unregister()`）或激活回滚时取消 |
| `ctx.onDispose(fn)` | 登记清理回调。逆序执行，每个只执行一次。停止阶段开始后不能再登记 |
| `ctx.events.on(name, listener)` | 订阅 `host:*` 或 `plugin:<id>:*` 事件。返回幂等的退订函数，停用时自动退订 |
| `ctx.events.emit(name, payload)` | 发布自己的事件，`name` 只能是一个短名。返回 Promise |
| `ctx.registerTool(spec)` / `ctx.unregisterTool(id)` | 注册、注销 AI 工具。只能注销本插件登记的工具 |
| `ctx.registerPromptProvider(spec)` / `ctx.unregisterPromptProvider(id)` | 每轮动态提示词贡献 |
| `ctx.registerIpc(channel, handler)` / `ctx.unregisterIpc(channel)` | 私有 IPC，完整通道名为 `plugin:<id>:<channel>` |
| `ctx.registerChannelAdapter(adapter)` / `ctx.unregisterChannelAdapter(id)` | 渠道适配器，两者都是异步的 |
| `ctx.storage.get(key)` / `set(key, value)` / `rootDir()` | 私有 JSON 存储，接口是同步的 |
| `ctx.deps` | 只包含 manifest 中声明过的服务，未声明的服务为 `undefined` |
| `ctx.log(...args)` | 输出到主进程控制台，前缀为 `[plugin:<id>]` |

补充说明：

- IPC 通道名需匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`，重复注册会抛错。handler 收到的参数是渲染端 `invoke` 传入的值，不含 Electron 的 event 对象。它的返回值（或 Promise 的结果）就是调用结果。
- 存储 key 的规则相同。每个 key 对应 `plugin-data/<id>/<key>.json`，写入时先写临时文件再重命名。值必须能被 JSON 序列化。文件损坏时 `get` 返回 `undefined`。
- 注册过程中抛错时，已登记的资源会被回滚。

## 6. 工具（registerTool）

```js
ctx.registerTool({
  id: "my-plugin_hello",
  name: "打招呼",
  description: "用户明确要求打招呼时使用",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "对方的称呼" } },
    required: [],
  },
  async execute(args) {
    return `你好，${args.name ?? "朋友"}`;
  },
});
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须以 `<插件id>_` 开头，不能与内置工具或其他插件的工具重名 |
| `name` | 是 | 显示名称 |
| `description` | 是 | 写给模型看的使用说明 |
| `enabled` | 是 | 布尔值 |
| `inputSchema` | 是 | `type` 必须是 `"object"`；`properties` 是 JSON Schema 片段；`required` 可选 |
| `execute(args, ctx?)` | 是 | 返回 `Promise<string>`。第二个参数的类型是 `PluginToolContext`，包含 `signal`、`conversationId`、`mode` 等字段 |
| `risk` | 否 | `safe`、`fs-read`、`fs-write`、`shell`、`network` 或 `input-control`。取 `safe` 时宿主直接放行 |
| `effectKind` | 否 | `read`、`mutation`、`verification`、`external_side_effect` 或 `unknown`。类型中没有 `write` |
| `modes` | 否 | 只能包含 `work` 与 `code`，含其他值时注册失败 |
| `verificationPolicy`、`ledgerPolicy`、`category`、`catalogHint`、`capability`、`needsContext`、`deprecated` | 否 | 可选元数据，定义见 `api.ts` |

`risk` 为 `safe` 时宿主直接放行；其他取值是否询问，由宿主的文件访问档位决定。因此只有只读、无副作用的工具才应标为 `safe`。`effectKind` 与 `risk` 由插件自己声明，SDK 与加载器不会检查它们是否与工具的实际行为一致。

## 7. 事件

### 订阅与发布规则

- 订阅名必须以 `host` 或 `plugin` 开头。每段以字母或数字开头，之后只能是字母、数字、`.`、`_`、`-`，最长 64 个字符。`plugin:<id>:<name>` 至少有三段。
- `emit(name)` 只接受单个短名。框架会补上 `plugin:<插件id>:` 前缀，因此插件无法发布 `host:*` 或其他插件的事件。
- 普通事件是异步派发的：`emit` 不等待监听器完成。监听器同步抛错或异步失败只记日志，不影响其他监听器。
- 异步监听器超过 5 秒会被记录为超时，但不会被终止。
- 轮次事件和调度事件只携带元数据，不含对话原文。需要历史内容时，使用 `conversations` 服务。

### 宿主事件

| 事件 | 发布时机 | 主要字段 |
| --- | --- | --- |
| `host:plugins:ready` | 启动时，已启用的插件全部激活之后；逐个等待监听器完成 | `pluginIds: string[]` |
| `host:plugins:stopping` | 应用退出时，停用任何插件之前；逐个等待监听器完成 | 无 |
| `host:turn:started` | 一轮对话开始 | `source`（`desktop`、`channel` 或 `scheduler`）、`mode`、`runId`；`desktop` 另有 `conversationId`、`inputMessageId`；`channel` 另有 `channel`；`scheduler` 另有 `taskId`、`schedulerRunId` |
| `host:turn:finished` | 一轮结束。终态为 `success`、`cancelled`、`timeout`、`runtime_error` 之一，只发布其中一个 | 同上，另有 `status`、`durationMs`。`desktop` 的 `finalMessageId` 只在消息落盘确认后出现 |
| `host:turn:completed` | v1 兼容事件，仅在成功终态时发布 | `source`、`mode`、`conversationId`，以及可选的 `channel`、`runId` |
| `host:tool:finished` | 工具执行完成 | `runId`、`toolId`、`toolCallId`、`status`（`success`、`failure`、`unknown` 或 `not_executed`）、`risk`、`durationMs`。不含参数与输出 |
| `host:scheduler:finished` | 调度任务完成 | `taskId`、`schedulerRunId`、`status`、`durationMs` |

- 桌面轮次的 `host:turn:finished` 需要同时拿到终态与消息落盘确认。落盘确认的等待上限为 60 秒，超时则放弃发布，不会补发。
- 所有事件都带 `eventId` 与 `timestamp`。`eventId` 只用于诊断关联，不保证恰好一次投递。

## 8. 提示词 Provider

```js
ctx.registerPromptProvider({
  id: "status",                  // 当前插件内唯一
  modes: ["chat", "work"],       // 可选；省略时 chat、work、code 全部生效
  sources: ["conversation"],     // 可选；省略时只参与 conversation 与 scheduler
  provide({ source, mode, userText, conversationId, channel, signal }) {
    if (signal.aborted) return "";
    return `插件运行状态：online；当前模式：${mode}`;
  },
});
```

- 全局名称为 `plugin:<插件id>:<provider-id>`，不同插件可以使用相同的短 id。
- `sources` 的可选值是 `conversation`、`scheduler` 与 `plugin-agent`。`plugin-agent` 只在插件通过 `llm.runGoal()` 发起的无头运行中生效，必须显式声明。
- 以下情况注册失败：id 不合法、`modes` 含未知值、`sources` 为空数组或含未知值、`provide` 不是函数、同一插件内 id 重复。
- 返回值会去掉首尾空白。空字符串直接跳过，超过 16000 字符则截断。
- 所有 Provider 的内容合计最多 32000 字符，超出部分被截断或忽略。
- 单个 Provider 最多等待 2 秒。超时、抛错或返回值不是字符串时，只跳过它自己，并写入日志。
- 结果按注册顺序拼接。每段开头有 `[插件上下文：plugin:<id>:<provider-id>]` 标题，段与段之间用分隔线隔开。内容进入每轮的运行时上下文，不修改核心提示词。

## 9. 数据服务（deps）

在 manifest 的 `deps` 中声明后，`ctx.deps.<名称>` 才会被注入。未声明的服务为 `undefined`。

### llm

```js
const text = await ctx.deps.llm.generateText(
  [{ role: "user", content: "把这段话翻译成英文：……" }],
  { maxTokens: 1024, timeoutMs: 30000, purpose: "translate" },
);
```

- `messages` 中的 `role` 取 `system`、`user` 或 `assistant`。
- `maxTokens` 的取值范围是 1 到 8192，缺省 1024。
- `timeoutMs` 的取值范围是 1000 到 300000，缺省取聊天超时设置，并封顶 120 秒。
- `purpose` 只是诊断标签，会加上插件 id 前缀，不影响模型选择。`signal` 可以传入插件自己的取消信号。
- 调用使用宿主当前的模型配置，经过宿主的 LLM 队列，并对限流错误做重试。插件不需要自带密钥。
- 较新的宿主还提供可选的 `runGoal(options)`，用于无头目标运行，默认最多 50 轮工具调用、整体时限 15 分钟。使用前先判断它是否存在。

### channels

`ctx.deps.channels.has(id)`：只读，返回该渠道是否已经存在。

### secrets

提供 `get(key)`、`set(key, value)` 与 `delete(key)`。

- 只能存字符串。key 的规则与 `ctx.storage` 相同。
- 数据保存在 `plugin-data/<id>/secrets/`。文件名是 key 的 SHA-256 加 `.enc`，内容经系统安全存储加密。
- 系统安全存储不可用时抛出 `E_STORAGE_UNAVAILABLE`，不会退化为明文保存。
- 卸载插件时密钥默认保留。
- `delete` 对不存在的 key 是幂等的，返回 `false`。

### workspace

`getBinding(conversationId)`：只读。会话不存在或未绑定工作区时返回 `null`；否则返回 `{ conversationId, root, displayName }`。没有绑定、解绑或选择目录的接口。

### conversations

- `list({ cursor?, limit? })`：每页默认 20 条，最多 100 条，返回 `{ items, nextCursor? }`。每项包含 `id`、`title`、`mode`、`createdAt`、`updatedAt`。
- `getMessages({ conversationId, cursor?, limit?, fromMessageId?, throughMessageId? })`：每页默认 50 条，最多 100 条，只返回 user 与 assistant 的纯文本。`fromMessageId` 与 `throughMessageId` 是包含式边界，首次调用时会冻结进游标。边界消息不存在时抛出 `E_NOT_FOUND`。
- 游标是不透明字符串。如果传入的参数与生成游标时不一致，会抛出 `E_INVALID_ARGUMENT`。
- 返回值中的 `range` 说明本次实际冻结的边界。

### scheduler

提供 `createTask(input)`、`listTasks()`、`updateTask(id, patch)`、`deleteTask(id)` 与 `getHistory(id, limit?)`。

- 插件只能访问自己创建的任务。访问其他插件或用户的任务会抛出 `E_NOT_OWNER`。
- 新建的任务一律停用，并且没有授权记录。必须由用户在宿主界面确认之后才会运行。
- 修改执行规格（计划、提示词、模式、工具白名单）会撤销已有授权，任务回到停用状态。只修改标题不会撤销授权。
- 计划类型有四种：`once`（`runAt` 为 ISO 时间，创建时必须晚于当前时间）；`daily`（`timeOfDay` 为 `HH:mm`）；`weekly`（`dayOfWeek` 取 0 到 6，0 是周日，另加 `timeOfDay`）；`interval`（`every` 为正整数，`unit` 为 `minutes`（最多 1440）或 `hours`（最多 168））。
- `mode` 取 `chat`、`work` 或 `code`。`allowedToolIds` 必须是字符串数组，插件任务不支持“全部工具”模式。
- `getHistory` 默认返回 10 条，最多 100 条，只包含诊断摘要。

### speech-input（已移除）

旧资料中提到的语音输入依赖（`speech-input` 声明，以及对应的 `ctx.deps` 租约接口）已经不在当前 API 中。manifest 中声明 `speech-input` 会导致校验失败。不要再按旧资料实现这部分。

## 10. 渠道适配器（进阶）

- `ctx.registerChannelAdapter(adapter)` 需要适配器提供 `id`、`displayName`、`capability`、`start()`、`stop()`、`onMessage`、`send(message)` 与 `getStatus()`。
- 注册时会立即启动适配器。启动失败时撤销注册并抛出错误。
- 同 id 已被占用时注册失败。
- 注册本身不要求声明 `deps: ["channels"]`。声明它只是为了使用 `ctx.deps.channels.has(id)`。
- 模拟上下文不支持渠道，只能在宿主中验证。

## 11. 错误码

宿主服务失败时会抛出带有 `code` 字段的错误对象。插件应使用 `isPluginHostError(error)` 判断，再按 `error.code` 分支，不要去匹配 message 的文字。

```js
const { isPluginHostError } = require("@firefly/plugin-sdk");

try {
  // 调用宿主服务
} catch (error) {
  if (isPluginHostError(error) && error.code === "E_NOT_FOUND") {
    // 处理“不存在”的情况
  }
}
```

| 错误码 | 含义 |
| --- | --- |
| `E_INVALID_ARGUMENT` | 参数或游标不合法 |
| `E_NOT_FOUND` | 会话、消息或任务不存在 |
| `E_NOT_OWNER` | 访问了不属于本插件的调度任务 |
| `E_STORAGE_UNAVAILABLE` | 系统安全存储不可用 |
| `E_PLUGIN_STOPPING` | 插件已进入停止阶段 |
| `E_INTERNAL` | 宿主内部错误，细节只写入宿主日志 |
| `E_CAPABILITY_UNAVAILABLE`、`E_NO_ACTIVE_INPUT_TARGET` | 类型中保留，当前宿主服务不会抛出 |

## 12. SDK 与测试工具

- 包名为 `@firefly/plugin-sdk`，版本 `0.2.0`，标记为 `private`，不发布到 npm。
- 构建命令是 `npm run build:plugin-sdk`；打包命令是 `npm pack ./packages/plugin-sdk`，生成的 tarball 名称形如 `firefly-plugin-sdk-0.2.0.tgz`。插件项目用 `npm install /path/to/firefly-plugin-sdk-0.2.0.tgz` 安装。
- 主入口同时提供 ESM 与 CJS 两种格式。它导出全部公开类型，以及 `CURRENT_PLUGIN_API_VERSION`、`PLUGIN_CAPABILITIES`、`PLUGIN_HOST_ERROR_CODES`、`isPluginHostError` 与 `validateManifestData`。
- 只导入类型不会产生运行时依赖。实际导入上述函数或常量时，插件需要把 SDK 的运行时代码和依赖（`ajv`）一并打包。
- `@firefly/plugin-sdk/testing` 导出以下三个函数：
  - `createMockPluginContext({ pluginId?, deps? })`。返回的对象额外提供 `tools`、`promptProviders`、`ipcChannels`、`emittedEvents`、`subscriptions`、`cleanups` 与 `dispose()`，便于在测试中断言。
  - `assertPluginTool(tool, pluginId)`。检查工具 id 前缀、`name`、`description`、`inputSchema.type` 与 `execute`，并把所有问题汇总后一次性抛出。
  - `assertValidManifest(data)`。只做结构层校验。
- 模拟上下文的局限：`dispose()` 只会触发取消信号并逆序执行 `onDispose` 回调，不会调用插件的 `unregister()`；存储是内存中的 Map，不写 JSON 文件；`registerChannelAdapter` 会抛错；`log` 默认静默；它不模拟 Electron，也不等同于真实宿主。

## 13. 设置面板与 Panel Bridge

### 挂载条件

- manifest 声明了合法的 `settingsPanel`，并且插件处于运行状态时，面板才会出现在设置页中。
- `settingsSection` 为 `channels` 时挂在渠道分区，否则挂在插件分区。
- 面板外层是一张卡片，显示插件名称与版本。卡片内部是一个 iframe，地址为 `firefly-plugin://<插件id>/<settingsPanel>`。

### 协议与安全

- 协议只服务已启用插件的文件。允许的扩展名为 `.html`、`.js`、`.mjs`、`.css`、`.json`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.svg`、`.ico`、`.woff` 与 `.woff2`，其余文件一律返回 404。
- 路径中不允许出现 `..`、斜杠、反斜杠、NUL 与盘符形式。解析后的真实路径必须仍然位于插件目录之内。
- iframe 的 `sandbox` 属性为 `allow-scripts allow-same-origin`。面板不能自行声明属于哪个插件，宿主根据 iframe 的归属判断每条消息。
- 面板应只通过 Panel Bridge 与宿主通信。

### 在面板中引入桥

```html
<script src="/.firefly/panel-bridge.js"></script>
```

`/.firefly/` 是保留路径，由宿主提供该文件。插件目录中的同名文件不会被读取。

### window.FireflyPanel

| 成员 | 说明 |
| --- | --- |
| `invoke(channel, ...args)` | 返回 Promise。转发到 `plugin:<id>:<channel>`，即 `ctx.registerIpc` 登记的处理函数。失败时 Promise 被拒绝 |
| `onTheme(callback)` | 宿主下发主题时回调，返回取消订阅的函数。主题的 tokens 会被写入面板根元素的样式 |
| `ready()` | 立即上报一次内容高度 |

- 高度自动上报，宿主把它限制在 120 到 800 像素之间。
- 宿主在面板加载完成时，以及主题变化时下发主题。tokens 的名称由宿主决定，面板应读取消息中的 tokens，不要硬编码宿主的变量名。面板自己定义的 CSS 变量，建议使用 `--ff-` 前缀。

## 14. 目录、ZIP 与卸载

### 目录布局

```text
<userData>/plugins/<id>/        用户插件。打包版的 userData 是 %APPDATA%\Firefly
<userData>/plugin-data/<id>/    插件私有数据：<key>.json 与 secrets/。卸载时保留
src/plugins/<id>/               内置插件的源码位置，构建时会复制进应用。当前仓库没有内置插件子目录
```

安装过程中还会用到 `plugin-install-staging/`（解压暂存）、`plugin-install-backups/`（替换时的旧版本备份）与 `plugin-install-metadata/`（插件市场的来源记录）。

### ZIP 限制

- 压缩包不超过 50 MiB；条目不超过 2000 个；单个条目解压后不超过 50 MiB；所有条目解压后的总量不超过 200 MiB；超过 1 MiB 的条目，压缩比不得超过 200。
- 以下内容会被拒绝：加密压缩包、符号链接、绝对路径、`..`、盘符路径、Windows 保留名（如 `CON`、`NUL`、`COM1`、`LPT1`）、以点或空格结尾的路径段、大小写冲突的重复路径，以及名为 `firefly-market.json` 的文件（它是宿主保留的来源记录）。
- 目录布局：`manifest.json` 位于 ZIP 根目录；或者 ZIP 根下只有一个文件夹，`manifest.json` 位于其中（忽略 `__MACOSX`）。

### 导入与替换

1. 校验压缩包与 manifest，解压到 `plugin-install-staging/`。
2. 检查目标目录：不存在则直接安装；已存在则弹出“替换”确认。
3. 新安装的插件默认停用。替换时保留启停设置与 `plugin-data/`，旧目录先备份，失败时自动回滚。
4. 原子重命名到 `plugins/<id>/`，然后重新扫描。

- 用户 ZIP 不能覆盖内置插件，同 id 会被拒绝。
- 插件市场安装走同一条导入流程，并额外校验 id 与版本是否与市场登记一致。

### 卸载

- 只能卸载用户插件，内置插件不能卸载。
- 顺序是：停用插件，把启停记录改为未启用，删除该插件创建的定时任务，最后删除插件目录。定时任务删除失败时卸载会中止，目录保留。
- `plugin-data/<id>/` 保留。
