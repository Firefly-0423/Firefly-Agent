# Firefly 插件开发指南

本文面向插件开发者，介绍如何从零创建、测试、打包并安装一个 Firefly 插件。权限与信任模型、存储规范及目录发布流程见 [plugin-authoring.md](./plugin-authoring.md)。

> **当前 SDK 版本基线**：`@firefly_wu/plugin-sdk` **`0.2.1`**（`plugin-sdk/package.json`），对应宿主插件契约 **`CURRENT_PLUGIN_API_VERSION = 1`**（`plugin-sdk/src/api.ts`）。关于 1.2.0 设计规格中已规划但当前尚未实现的接口，见文末「[1.2.0 规划中，尚未提供](#120-规划中尚未提供)」。

## 1. 安装 SDK 与最小目录结构

从 npm 或本地 tarball 安装 SDK（`plugin-sdk/README.md`）：

```bash
npm install @firefly_wu/plugin-sdk
```

若在本仓库基于源码构建本地 SDK 包（`examples/README.md`）：

```bash
npm run build:plugin-sdk
npm pack ./plugin-sdk
# 在插件项目目录安装生成的 tarball
npm install /path/to/firefly_wu-plugin-sdk-<版本>.tgz
```

一个最小插件目录（例如 `my-plugin/`）直接放在 ZIP 根目录或唯一顶层子目录中：

```text
my-plugin/
├── manifest.json   # 必填：插件清单
├── index.cjs       # 必填：entry 指定的入口文件（.cjs / .js / .mjs）
├── icon.png        # 可选：icon 字段声明的图标（<= 2 MiB）
└── panel.html      # 可选：settingsPanel 字段声明的设置页 HTML（<= 1 MiB）
```

## 2. 编写 `manifest.json`

`manifest.json` 的结构由 `plugin-sdk/src/manifest.schema.json` 约束，宿主在 `src/plugins/loader.ts`（`inspectPluginDir`）与 SDK 的 `validateManifestData`（`plugin-sdk/src/validate-manifest.ts`）共同执行校验（Schema `additionalProperties: false`，不允许额外未知字段）：

| 字段 | 必填 | 类型 / 约束 | 说明 |
| --- | --- | --- | --- |
| `apiVersion` | 是 | `1`（`CURRENT_PLUGIN_API_VERSION`） | 不等于 `1` 会被加载器拒绝 |
| `id` | 是 | 字符串，正则 `/^[a-z0-9]+(-[a-z0-9]+)*$/` | 全局唯一小写连字符 ID（如 `weather-tool`） |
| `name` | 是 | 非空字符串 | 展示给用户的插件名称 |
| `version` | 是 | 合法 SemVer 字符串 | 如 `0.1.0`、`1.0.1` |
| `description` | 是 | 字符串 | 插件说明 |
| `author` | 是 | 字符串 | 作者署名 |
| `entry` | 是 | `.cjs` / `.js` / `.mjs` 裸文件名 | 只能是插件目录内的单文件名，禁止路径分隔符与指向目录外的符号链接 |
| `deps` | 否 | `PluginCapability[]` | 可选值：`"conversations"`、`"scheduler"`、`"llm"`、`"secrets"`、`"workspace"`、`"channels"` |
| `icon` | 否 | 图片裸文件名（`.png`/`.jpg`/`.jpeg`/`.webp`/`.svg`） | 须位于插件目录内且 `<= 2 MiB` |
| `settingsPanel` | 否 | `.html` 裸文件名 | 须位于插件目录内且 `<= 1 MiB`；存在且插件正在运行时才挂载 |
| `settingsSection` | 否 | `"channels"` \| `"plugins"` | 面板挂载分区，缺省挂到 `"plugins"` |
| `defaultEnabled` | 否 | 布尔值 | 仅对随应用内置的插件生效；**用户自行安装的插件首次安装一律默认停用**（`plugin-sdk/LIFECYCLE.md`、`plugin-sdk/src/api.ts`） |

示例（参考 `examples/weather-tool/manifest.json`）：

```json
{
  "apiVersion": 1,
  "id": "my-plugin",
  "name": "我的示例插件",
  "version": "0.1.0",
  "description": "演示工具与宿主服务的最小插件。",
  "author": "示例作者",
  "entry": "index.cjs",
  "defaultEnabled": false,
  "deps": ["secrets"]
}
```

## 3. 插件入口与生命周期

入口模块导出一个满足 `FireflyPlugin`（`plugin-sdk/src/api.ts`）的对象（CJS 可同时写 `module.exports = plugin; module.exports.default = plugin;`，见 `examples/system-status/index.cjs`；ESM 通过 `export default plugin` 导出）：

```ts
import type { FireflyPlugin, PluginContext } from "@firefly_wu/plugin-sdk";

const plugin: FireflyPlugin = {
  async register(ctx: PluginContext) {
    // 注册工具、提示词 Provider、IPC、事件监听与清理回调
  },

  async open() {
    // 可选：用户在插件面板点击「打开」时调用（如打开独立窗口）
  },

  async unregister() {
    // 可选：插件停止或卸载前调用的收尾钩子
  },
};

export default plugin;
```

停止与清理顺序（依据 `src/plugins/manager.ts` 与 `examples/README.md`）：

1. 宿主先触发 `beginStop()`，此时 `ctx.signal` 变为已中止，后续调用注册类接口会直接抛出“插件停止后不能再……”错误。
2. 调用插件导出的 `unregister()`（若已定义）。
3. 调用 `ctx.dispose()`，按**逆序**依次执行通过 `ctx.onDispose()` 登记的清理回调（每个最多执行一次）。

> **注意**：不要在 `unregister()` 中提前清空模块作用域变量，又在 `onDispose()` 中把该变量写入 `ctx.storage`（参见 `examples/README.md`「当前源码限制」记录的既有教训）。需要持久化的状态应在写入发生时保存或先落盘后再清内存状态。

此外，变更 `.mjs` 入口的子模块或更换版本后应通过完整重启应用生效，不要依赖页面刷新（`plugin-sdk/LIFECYCLE.md`）。

## 4. 使用 `plugin-sdk` 提供的能力

`@firefly_wu/plugin-sdk`（`plugin-sdk/src/index.ts`）导出以下可用成员：

- 来自 `plugin-sdk/src/api.ts`：全部契约类型（如 `FireflyPlugin`、`PluginContext`、`PluginTool`、`PluginPromptProvider`、`PluginChannelAdapter`、`PluginDeps` 等）与常量/守卫函数 `CURRENT_PLUGIN_API_VERSION`、`PLUGIN_CAPABILITIES`、`PLUGIN_HOST_ERROR_CODES`、`isPluginHostError`。
- 来自 `plugin-sdk/src/validate-manifest.ts`：`validateManifestData`、`ManifestValidationResult`。

### 4.1 注册工具（`ctx.registerTool`）

- 工具 `id` **必须**以 `${pluginId}_` 开头（`src/plugins/context.ts`、`plugin-sdk/src/testing/index.ts`）。
- `inputSchema` 顶层必须是 `{ type: "object", properties: { ... }, required?: [...] }`。
- `execute(args, ctx)` 返回字符串（`Promise<string>`）；若声明 `needsContext: true`，宿主会传入 `PluginToolContext`（含 `userQuery`、`conversationId`、`runId`、`signal`、`resolvedWorkspaceRoot`、`mode`、`permissionMode`）。
- 建议显式声明 `risk`（`PluginToolRisk`）、`modes`（`Array<"code" | "work">`）、`effectKind`、`verificationPolicy` 与 `ledgerPolicy`（`"bypass"` 表示不按参数缓存结果）。关于为何新插件不要使用 `"safe"`，见 [plugin-authoring.md](./plugin-authoring.md)。

### 4.2 注册提示词 Provider（`ctx.registerPromptProvider`）

用于每轮按需补充动态上下文片段（不修改核心提示词文件）：

```ts
ctx.registerPromptProvider({
  id: "memory-context", // 框架自动补全前缀 plugin:<pluginId>:
  modes: ["chat", "work"],
  sources: ["conversation", "scheduler"], // 若想参与插件无头循环，须显式包含 "plugin-agent"
  provide(input) {
    if (input.signal.aborted) return "";
    return `当前会话模式：${input.mode}`;
  },
});
```

注意事项（`plugin-sdk/README.md`、`plugin-sdk/src/api.ts`）：

- `sources` 可选值为 `"conversation"`、`"scheduler"`、`"plugin-agent"`；省略时仅作用于 `"conversation"` 与 `"scheduler"`。
- 返回空字符串 `""` 表示本轮不追加。只应放简短事实性上下文，不要拼接覆盖系统规则的指令。

### 4.3 订阅与发布事件（`ctx.events`）

- **订阅**：`ctx.events.on(event, listener)` 需使用完整命名空间 `host:*` 或 `plugin:<id>:*`，返回退订函数。单个监听器异步超时为 `5000ms`（`PLUGIN_EVENT_LISTENER_TIMEOUT_MS`，`src/plugins/events.ts`）。
- **常用宿主事件**：
  - `host:turn:started`（`PluginTurnStartedEvent`）与 `host:turn:finished`（`PluginTurnFinishedEvent`，按 `source: "desktop" | "channel" | "scheduler"` 收窄字段；`desktop` 分支只有在最终 assistant 消息落盘后才会带 `finalMessageId`）
  - `host:turn:completed`（`PluginTurnCompletedEvent`，仅含元数据）
  - `host:tool:finished`（`PluginToolFinishedEvent`）与 `host:scheduler:finished`（`PluginSchedulerFinishedEvent`）
  - 生命周期事件 `host:plugins:ready`、`host:plugins:stopping`（`src/plugins/manager.ts`）
- **发布自定义事件**：`await ctx.events.emit("updated", payload)` 会自动补全为 `plugin:<pluginId>:updated`（主题段须满足 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`）。

### 4.4 注册 IPC 与设置面板（`ctx.registerIpc` + `settingsPanel`）

- `ctx.registerIpc(channel, handler)` 自动加上命名空间 `plugin:${pluginId}:${channel}`（本地段须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`，`src/plugins/context.ts`）。
- 若清单声明 `settingsPanel: "panel.html"`，宿主通过 `firefly-plugin://<pluginId>/panel.html` 加载（`src/main/features/plugins/panel/plugin-panel-protocol.ts`）。
- 面板 HTML 中引入 `<script src="/.firefly/panel-bridge.js"></script>` 后，即可通过 `window.FireflyPanel.invoke(channel, ...args)` 调用对应 `registerIpc` 通道，并通过 `window.FireflyPanel.onTheme(cb)` / `window.FireflyPanel.ready()` 同步主题与面板高度（`src/main/features/plugins/panel/panel-bridge.js`、`examples/system-status/panel.html`）。

### 4.5 私有存储与宿主服务（`ctx.storage` & `ctx.deps`）

- **`ctx.storage`**（无需 `deps` 声明）：`get<T>(key)`、`set<T>(key, value)`、`rootDir()`。注意持久化通过 `JSON.stringify` / `JSON.parse` 执行（`src/plugins/storage.ts`），不要直接存 `Map` / `Set`（参见 `examples/README.md`）。
- **`ctx.deps`**（必须在 `manifest.json` 的 `deps` 数组声明，否则对应字段为 `undefined`）：
  - `"secrets"` → `ctx.deps.secrets`: `get(key)`、`set(key, value)`、`delete(key)`（见 `examples/weather-tool/index.ts`）。
  - `"llm"` → `ctx.deps.llm`: `generateText(messages, options?)`（`maxTokens` 1–8192 默认 1024，`timeoutMs` 1000–300000），可选 `runGoal?(options)` 无头目标循环（旧宿主可能缺省，插件需准备兼容回退）。
  - `"conversations"` → `ctx.deps.conversations`: 只读 `list({ cursor?, limit? })` 与 `getMessages({ conversationId, cursor?, limit?, fromMessageId?, throughMessageId? })`（长记忆插件应使用事件中的 `inputMessageId` / `finalMessageId` 固定边界并循环游标分页）。
  - `"workspace"` → `ctx.deps.workspace`: `getBinding(conversationId)`（只读已绑定工作区根目录与展示名）。
  - `"scheduler"` → `ctx.deps.scheduler`: `listTasks()`、`getHistory(id, limit?)`、`createTask(input)`、`updateTask(id, patch)`、`deleteTask(id)`。只能操作本插件创建的任务，新建任务默认为停用状态且必须明确指定 `allowedToolIds`；修改执行规格（`schedule`、`prompt`、`mode`、`allowedToolIds`）会自动撤销既有用户授权（见 `examples/scheduled-automation/index.ts`）。
  - `"channels"` → `ctx.deps.channels`: 只读 `has(id)`；注册消息渠道适配器通过 `ctx.registerChannelAdapter(adapter)` 完成（`PluginChannelAdapter`）。
- **错误判断**：宿主服务失败时抛出 `PluginHostError`，插件应通过 `isPluginHostError(err)` 检查 `err.code`（`E_CAPABILITY_UNAVAILABLE`、`E_INVALID_ARGUMENT`、`E_NOT_FOUND`、`E_NOT_OWNER`、`E_STORAGE_UNAVAILABLE`、`E_NO_ACTIVE_INPUT_TARGET`、`E_PLUGIN_STOPPING`、`E_INTERNAL`），避免硬编码解析错误文案 `message`。

## 5. 本地测试

`@firefly_wu/plugin-sdk/testing`（`plugin-sdk/src/testing/index.ts`）提供脱离宿主的契约检查与上下文替身：

- `assertValidManifest(data)`：使用与宿主一致的 JSON Schema 检查字段结构、类型与枚举。
- `assertPluginTool(tool, pluginId)`：校验工具 ID 是否以 `${pluginId}_` 开头、`name`/`description`、`inputSchema.type === "object"` 与 `execute` 函数。
- `createMockPluginContext({ pluginId?, deps? })`：返回 `MockPluginContext`，记录注册的工具、Prompt Provider、IPC 通道、发出的事件、订阅记录与清理回调，并提供 `dispose()` 触发 `signal` 并逆序执行 `cleanups`。

典型单元测试结构（参考 `scripts/plugin-sdk/smoke-examples.mjs` 与 `plugin-sdk/src/testing/index.test.ts`）：

```ts
import { assertPluginTool, assertValidManifest, createMockPluginContext } from "@firefly_wu/plugin-sdk/testing";
import manifest from "./manifest.json";
import plugin from "./index";

assertValidManifest(manifest);
const ctx = createMockPluginContext({ pluginId: manifest.id, deps: { /* 按需要注入假服务 */ } });
await plugin.register(ctx);
for (const tool of ctx.tools) assertPluginTool(tool, manifest.id);
await plugin.unregister?.();
await ctx.dispose();
```

> **Mock 已知局限**（`plugin-sdk/README.md`、`examples/README.md`）：
> 1. `ctx.dispose()` 只中止信号并逆序执行 `onDispose` 回调，**不会代调 `plugin.unregister()`**，测试中若要覆盖停止路径须显式先调 `unregister()`。
> 2. Mock 存储使用内存 `Map` 保存对象引用，不做 `JSON.stringify` 序列化（无法替真实宿主暴露 `Map` 序列化丢失等问题）。
> 3. `registerChannelAdapter()` / `unregisterChannelAdapter()` 与真实 Electron 窗口、宿主格式检查（如 `id` 正则、SemVer、入口文件存在性、ZIP 边界）均需真实宿主验收。

在本仓库内可执行以下插件验证命令（`package.json`、`examples/README.md`）：

- `npm run check:plugin-sdk`：构建 SDK 并校验导出包内容。
- `npm run test:plugin-examples`：打包 SDK tarball，在临时目录编译 4 个 TS 示例并通过 `scripts/plugin-sdk/smoke-examples.mjs` 冒烟验证。
- `npm run test:plugin-marketplace`：验证离线目录构建与插件市场测试。
- `npm run check:plugin-schema`：检查 `plugin-sdk/src/manifest.schema.json` 与 `api.ts` 类型定义是否同步。

## 6. 打包与本地安装

1. **处理运行时依赖**：
   - 若插件入口**仅**使用 `import type` 引用 `@firefly_wu/plugin-sdk`（参考 `examples/weather-tool/index.ts`），编译后的 `.cjs` / `.js` / `.mjs` 不需要带第三方运行包。
   - 若入口**实际导入** SDK 函数或常量（如 `isPluginHostError`、`validateManifestData`、`PLUGIN_CAPABILITIES` 等），**必须**将运行时代码及其依赖（如 `ajv`）随入口一并打包进插件目录（`plugin-sdk/README.md`、`examples/README.md`）。
2. **ZIP 包约束**（`src/plugins/installer.ts` `PLUGIN_ZIP_LIMITS` 与路径校验）：
   - 必须为 `.zip` 扩展名，非加密 ZIP。
   - `manifest.json` 必须位于 ZIP 根目录，或位于唯一的顶层子目录内（忽略 `__MACOSX`）。
   - 条目数 `<= 2000`，压缩包总大小 `<= 50 MiB`，单文件解压后 `<= 50 MiB`，总解压大小 `<= 200 MiB`；超过 `1 MiB` 的条目压缩比不得高于 `200`。
   - 禁止符号链接（symlink）、路径穿越（`..` / 绝对路径 / 盘符）、大小写冲突重复路径、Windows 保留文件名，且禁止包含宿主保留文件 `firefly-market.json`。
3. **安装与生效**：
   - 打开聊天窗口的插件面板导入 ZIP；首次导入后默认为**停用**状态，确认可信后手动启用。
   - 若替换或更新已安装插件，新版本写入独立版本目录，**需完整退出整个应用并重新启动**才会尝试切换到新版本（关闭聊天窗口不等于完整重启，`plugin-sdk/LIFECYCLE.md`）。

## 7. 常见错误排查

| 错误或现象 | 常见原因与排查方向 |
| --- | --- |
| `宿主未提供已声明的依赖: <name>` | `deps` 写了不受支持的字段，或精简测试环境未注入对应宿主服务（`src/plugins/context.ts`） |
| `E_CAPABILITY_UNAVAILABLE` / `deps.<x>` 为 `undefined` | 忘记在 `manifest.json` 的 `deps` 数组中声明对应能力，或对应服务当前不可用 |
| `工具 id 必须以 "<pluginId>_" 开头` | 工具 `id` 命名未加 `<pluginId>_` 前缀 |
| `manifest` 结构或路径校验失败 | 存在未在 Schema 定义的多余字段、`apiVersion !== 1`、`id` 非小写连字符、`entry` 写了子路径（如 `dist/index.js`）或扩展名非 `.cjs`/`.js`/`.mjs` |
| ZIP 导入报错被拒 | 未将 `manifest.json` 放在根目录或唯一顶层目录、含符号链接、`firefly-market.json`、超限或大小写重复路径（`src/plugins/installer.ts`） |
| 导入 SDK 运行时函数后在宿主报模块找不到 | TS 编译未把 `@firefly_wu/plugin-sdk` / `ajv` 打包进插件目录，仅直接复制了裸 `index.js`（`examples/README.md`） |
| 安装更新后仍运行旧代码 / 修改 `.mjs` 子模块未生效 | 宿主不热切换正在运行的插件目录，且 ESM 模块缓存需完整退出并重启应用才失效（`plugin-sdk/LIFECYCLE.md`） |
| 停用重启后 `ctx.storage` 变成空值或丢方法 | 存了 `Map` 等非 JSON 原生对象（恢复后变普通对象），或在 `unregister()` 先清状态后才在 `onDispose()` 写盘（`examples/README.md`） |

## 1.2.0 规划中，尚未提供

仓库中存在设计规格文档 [plugin-sdk-1-2-0.md](../superpowers/specs/plugin-sdk-1-2-0.md)（状态：设计规格），规划对插件系统进行不兼容 0.x 的全新重构。**以下 1.2.0 能力在当前源码（`plugin-sdk/package.json` `0.2.1` 与 `plugin-sdk/src/`）中均尚未提供，切勿在当前插件中使用**：

- **包版本与工具链**：`@firefly_wu/plugin-sdk@1.2.0`、`bin` 命令 `firefly-plugin validate` / `firefly-plugin pack`（`.ffplugin` 包格式）目前均不存在（当前 `plugin-sdk/package.json` 无 `bin` 字段）。
- **新入口与错误处理**：`definePlugin`、`PluginError` / `PluginErrorCode`（`ERR_UNDECLARED`、`ERR_PERMISSION`、`ERR_RATE_LIMITED` 等）、新 `PluginContext` 布局（`ctx.version`、`ctx.dataDir`、`ctx.has()`、`ctx.tools`、`ctx.context`、`ctx.channels`、`ctx.model`、`ctx.sessions`、`ctx.workspace`、`ctx.schedules`、`ctx.secrets`、`ctx.ui`）及工具结构化四态返回值 `ToolResult` / `ToolCall.progress()` 均未实现。
- **新清单 `firefly.plugin.json`**：`schemaVersion: 1`、反向域名 `id`（`^[a-z0-9]+(\.[a-z0-9-]+){2,}$`）、`sdk`、`native` 标识、`permissions` 声明数组、工具 `risk` 必填且禁止 `"safe"`、独立窗口列表 `ui.windows` 等规则尚未接入当前加载器（当前仍读 `manifest.json` 与 `apiVersion: 1`）。
- **进程隔离与窗口桥**：基于 Electron `utilityProcess` 的独立插件进程、512 MB 内存轮询上限、60 秒 3 次崩溃熔断、`MessagePortMain` 通信帧、以及独立窗口桥 `window.fireflyPlugin` 均未实现；当前设置面板桥为 `/.firefly/panel-bridge.js`（`window.FireflyPanel`），插件代码仍在主进程运行。
- **测试替身 `createTestHost()`**：`@firefly_wu/plugin-sdk/testing` 当前仅导出 `createMockPluginContext`、`assertPluginTool`、`assertValidManifest`，尚无 `createTestHost()`。
- **权限、限频与数据边界收紧**：删去 `project-read-only`/`scoped` 旧档位值、插件 `shell` 在 `read-only` 档位改为询问、渠道 Work 仅放行 `fs-read`、模型调用每分钟默认 10 次限频与界面借用提示，以及切换到 `%APPDATA%\Firefly-1.2.0` 不迁移旧版 0.x 插件等事项均尚在规划或待实施阶段。
