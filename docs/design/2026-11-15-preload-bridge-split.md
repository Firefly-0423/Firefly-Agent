# `src/preload/index.ts` 拆分设计文档

- 状态：设计已由负责人确认（2026-11-15）
- 日期：2026-11-15
- 依据提交：`a96f254`
- 负责人：`hotaru`

> **安全与范围原则**：渲染进程不得直接访问 Node.js 或系统能力，跨进程调用只经受控 `preload` 桥接。本拆分属于纯模块化重构，不得新增暴露接口、不得放宽参数校验与字段过滤、不得丢失事件监听注销能力。

---

## 1. 现状：它承担了哪几件事

`src/preload/index.ts`（共 1257 行）目前在单个文件里集中定义了 **30 个 `window.*` 暴露对象** 并触发 **1 个已拆出模块**（`exposeMusicApi()` 暴露 `window.music`），合计向渲染进程暴露 **31 个全局桥接命名空间**，同时在内部持有页面级随机实例键 `pageTargetKey = crypto.randomUUID()`（L29）。

另有一个独立小窗脚本 `src/preload/memory-openrouter-once.ts`（17 行）：不经过 `index.ts` 与 `contextBridge`，仅在 `DOMContentLoaded` 后把一次性表单提交转发给 `ipcRenderer.invoke("memory-openrouter-once:prepare", ...)`。

### 1.1 按暴露对象与功能域分组清单

| 功能域 | `window.*` 名字与行号范围 | 使用的 IPC 通道与方向 | 监听注销方式与特殊逻辑 |
| --- | --- | --- | --- |
| **桌宠窗口与 Live2D** | `firefly`（L32–66，暴露于 L184）<br>`live2dWork`（L1036，调 `createLive2dWorkApi(ipcRenderer)`） | `send`: `WINDOW_MINIMIZE`, `WINDOW_MOVE_TO`, `WINDOW_SET_DRAGGING`<br>`invoke`: `WINDOW_SET_INTERACTIVE`, `WINDOW_GET_CURSOR_POSITION`<br>`on`: `PET_ZOOM`, `PET_VISIBILITY_CHANGED`<br>(`live2dWork`：`invoke` `LIVE2D_GET_WORKING`、`on` `LIVE2D_WORKING_CHANGED`) | `firefly` 用 `ipcRenderer.off`<br>`live2dWork` 用 `ipcRenderer.removeListener`，并把非 boolean 强转为 `false`、读取失败兜底 `false` |
| **桌面更新与窗口壳层** | `appUpdate`（L67–86，暴露于 L185）<br>`sidebar`（L269–283）<br>`toast`（L284–316） | `appUpdate`：`invoke` `APP_UPDATE_GET_STATE/DOWNLOAD/INSTALL`，`on` `APP_UPDATE_STATE`<br>`sidebar`：`send` `SIDEBAR_MINIMIZE/CLOSE/OPEN_SETTINGS`，`invoke` `SIDEBAR_TOGGLE_ALWAYS_ON_TOP`<br>`toast`：`invoke` `TOAST_GET_ALL`，`send` `TOAST_CLICKED/DISMISSED/RESIZE`，`on` `TOAST_PUSH/REMOVE` | `appUpdate` 用 `off`<br>`toast` 用 `removeListener` |
| **聊天窗口、媒体与语音** | `desktopAsr`（L87–101）<br>`chat`（L102–186）<br>`choice`（L263–268） | `desktopAsr`：`invoke` `DESKTOP_ASR_START/FRAME/STOP/CANCEL`<br>`chat`：`send` `CHAT_MINIMIZE/CLOSE/TOGGLE_MAXIMIZE/WINDOW_DRAG_START/END`，`invoke` `CHAT_IS_MAXIMIZED`, `STICKERS_GET_ENABLED`, `CHAT_INGEST_FILES`, `CHAT_CAPTION_IMAGE`, `CHAT_GET_IMAGE_PREVIEW`, `CHAT_GET_IMAGE_SEND_STRATEGY`, `SETTINGS_GET_GENERAL`, `CHAT_GET_REASONING_STATE`, `CHAT_SET_REASONING`, `SCREENSHOT_START/SAVE_TEMP`，`on` `SCREENSHOT_INSERT`<br>`choice`：`invoke` `CHOICE_RESOLVE` | `chat.onScreenshotInsert` 用 `removeListener`<br>`chat.ingestDroppedFiles`（L124–141）经 `webUtils.getPathForFile` 把 `File[]` 过滤转换为 `{ path, mime }[]`，全空不发 IPC<br>`choice.resolve`（L264–266）按字符串区分 `{ id, value }` 与 `{ id, answer }` |
| **Agent 运行与事件流** | `agui`（L187–245） | `invoke`: `AGUI_RUN`, `AGUI_CANCEL`, `AGENT_RUN_GET_INTERRUPTED`<br>`send`: `AGUI_RUN_PERSISTED`<br>`on`: `AGUI_EVENT` | 用 `ipcRenderer.off`；`onEvent`（L214–221）内部 `try/catch` 捕获回调异常防止崩溃 |
| **会话存储与侧栏布局** | `chatStore`（L1037–1172） | `invoke`: `SIDEBAR_LAYOUT_IPC.get/mutate`, `CHATS_LIST/GET/EXPORT_WORK_MARKDOWN/CREATE/APPEND/UPSERT/REPLACE_TAIL/COMPACT/RENAME/DELETE/PENDING_*/SET_PINNED/SET_MODEL_PROFILE/OPEN_WORKSPACE/SET_ACTIVE_SESSION/SET_WORKSPACE/PICK_WORKSPACE_FOLDER/OPEN_IN_REACT_WINDOW`<br>`send`: `CHATS_REACT_READY`<br>`on`: `SIDEBAR_LAYOUT_IPC.changed`, `CHATS_CHANGED`, `CHATS_REACT_SWITCH_SESSION` | 三组 `on*` 均用 `removeListener`<br>`setActiveSession`（L1138–1140）注入模块级 `pageTargetKey` 为 `rendererTargetId`；`pendingEdit`（L1112–1124）仅在 `userSticker !== undefined` 时附带该键 |
| **外观主题、字体与贴纸窗口** | `fireflyTheme`（L317–343）<br>`fireflyFont`（L344–358）<br>`fireflyAppearance`（L359–373）<br>`stickerManager`（L828–842） | `fireflyTheme`：`invoke` `UI_COLORS_GET`, `UI_THEME_GET`，`on` `UI_COLORS_CHANGED`, `UI_THEME_CHANGED`<br>`fireflyFont`：`invoke` `UI_FONT_GET`，`on` `UI_FONT_CHANGED`<br>`fireflyAppearance`：`invoke` `SETTINGS_GET_GENERAL`，`on` `CHAT_TYPOGRAPHY_CHANGED`<br>`stickerManager`：`send` `STICKERS_MINIMIZE/CLOSE`，`invoke` `STICKERS_GET_CONFIG/SET_ENABLED` | `fireflyTheme.onColorsChanged` 用 `removeListener`，`fireflyTheme.onChanged`、`fireflyFont.onChanged`、`fireflyAppearance.onChanged` 用 `off`<br>`fireflyAppearance` 的 `get`/`onChanged` 均通过 `normalizeChatDisplay(...)` 做字段归一化（L361、L365） |
| **设置中心主桥（超级对象）** | `settings`（L374–758，暴露于 L758） | 混合了 6 类能力（约 67 个顶层方法 + 1 个嵌套 `externalSkills`）：<br>1. 窗体与路由（L390–395, L446–454）：`send` `SETTINGS_MINIMIZE/CLOSE`，`on` `SETTINGS_SWITCH_SECTION`（`off`）<br>2. 配置/档案/模型/字体/桌宠/向量（L396–519）：`invoke` `SETTINGS_*` / `STICKERS_*` / `EMBEDDING_*` / `RERANKER_*` / `TOOL_*` 与 `send` `SETTINGS_SET_PET_*`<br>3. `externalSkills` DTO 网关 & 内置技能（L520–562）：`invoke` `EXTERNAL_SKILLS_*`, `SKILL_*`<br>4. MCP & 外部渠道（L563–662）：`invoke` `MCP_*` / `CHANNELS_*`，`on` `CHANNELS_INSTALL_PROGRESS`, `CHANNELS_STATUS_CHANGED`, `CHANNELS_WECHAT_QRCODE`, `CHANNELS_WECHAT_LOGIN_DONE`（均用 `off`）<br>5. 权限/Plan/PopQuiz 运行时交互（L663–750）：`invoke` `PERMISSION_*`/`PLAN_*`/`POP_QUIZ_*`，`on` `PLAN_STATE_CHANGED`, `PERMISSION_APPROVAL_REQUEST/SETTLED`, `POP_QUIZ_REQUEST/SETTLED`（均用 `removeListener`）<br>6. 快捷键捕获（L751–756）：`invoke` `SCREENSHOT_HOTKEY_CAPTURE_START/END` | 渠道和 `onSwitchSection` 用 `off`；`PLAN_STATE_CHANGED`、`PERMISSION_*`、`POP_QUIZ_*` 用 `removeListener`<br>`externalSkills`（L520–544）显式裁剪入参对象为 `{ sourceId, id, selection? }` / `{ token }` / `{}`，满足 `ExternalSkillsApi` 契约 |
| **插件与定时任务** | `plugins`（L759–794）<br>`pluginPanel`（L795–800）<br>`fireflyScheduler`（L801–827）<br>`schedulerEvents`（L246–262） | `plugins`：`invoke` `PLUGINS_LIST/SET_ENABLED/OPEN/RESCAN/IMPORT_ZIP/UNINSTALL/MARKET_*`，`on` `PLUGINS_CHANGED`<br>`pluginPanel`：`invoke` `PLUGINS_PANEL_INVOKE`<br>`fireflyScheduler`：`invoke` `SCHEDULER_LIST/ADD/UPDATE/DELETE/TOGGLE/FIRE_NOW/GET_HISTORY/GET_TOOLS`<br>`schedulerEvents`：`on` `SCHEDULER_EVENT` | `plugins.onChanged` 与 `schedulerEvents.onEvent` 用 `off`；`schedulerEvents.onEvent`（L248–255）包有 `try/catch` |
| **模型连接快照与 Token 用量** | `modelConfig`（L843–872）<br>`tokenUsage`（L1242–1256） | `modelConfig`：`invoke` `MODEL_CONNECTION_GET`, `MODEL_CONFIG_GET`, `MODEL_GET_INSTALL_STATUS`，`on` `MODEL_CONNECTION_CHANGED`, `MODEL_CONFIG_CHANGED`<br>`tokenUsage`：`invoke` `TOKEN_USAGE_GET/CLEAR/HISTORY/SESSION_STATS` | `modelConfig` 两处 `on*` 均用 `removeListener` |
| **受控浏览器（单页 & 多标签）** | `manualBrowser`（L876–905）<br>`manualBrowserWorkspace`（L906–959） | `manualBrowser`：`invoke` `IPC.BROWSER_PERMISSION/AVAILABILITY/COMMAND`，`on` `IPC.BROWSER_CHANGED`<br>`manualBrowserWorkspace`：`invoke` `MANUAL_BROWSER_WORKSPACE_IPC.availability/permission/command`，`on` `MANUAL_BROWSER_WORKSPACE_IPC.changed/toolsChanged` | 全部用 `removeListener`<br>通过 `withTab`（L873–875）与 `browserWorkspaceCommand`（L906–908）封装；权限仅允许 `{ kind: "get" \| "request" \| "revoke" }` 上报，禁止暴露直接放行方法 |
| **用户档案与记忆系统** | `user`（L960–991，暴露于 L1025）<br>`memoryPanel`（L992–1026）<br>`memoryAutomation`（L1027–1035） | `user`：`invoke` `USER_GET_PROFILE/SAVE_PROFILE/UPLOAD_AVATAR/GET_AVATAR`，`on` `USER_PROFILE_CHANGED/AVATAR_CHANGED`<br>`memoryPanel`：`invoke` `MEMORY_PANEL_*`, `MEMORY_SHADOW_*`<br>`memoryAutomation`：`invoke` `MEMORY_AUTOMATION_STATE/CONFIGURE` | `user` 用 `off` |
| **工作区、代码 Review 与 Git** | `review`（L1173–1181）<br>`workspaceFiles`（L1182–1198）<br>`openInApp`（L1199–1207）<br>`codeGit`（L1208–1241） | `review`：`invoke` `REVIEW_GET/RESTORE`<br>`workspaceFiles`：`invoke` `WORKSPACE_FILES_LIST/READ/SAVE`<br>`openInApp`：`invoke` `WORKSPACE_OPEN_IN_LIST_APPS/OPEN_IN`<br>`codeGit`：`invoke` `CODE_GIT_STATUS/WATCH/UNWATCH/SWITCH_BRANCH/COMMIT/PUSH`，`on` `CODE_GIT_CHANGED` | `codeGit.onChanged` 用 `removeListener` |
| **音乐集成（已拆出先例）** | `music`（`src/preload/music.ts:1-10`，在 `index.ts:1257` 调 `exposeMusicApi()`） | `invoke`: `MUSIC_QQ_GET_STATUS`, `MUSIC_QQ_CONTROL` | 在子模块内部直接调用 `contextBridge.exposeInMainWorld("music", ...)` |

### 1.2 已拆出模块的两种现行接回约定

1. **先例 1 — 工厂注入模式（`src/preload/live2d-work-api.ts`）**：
   - 文件内部只依赖最小 `Live2dWorkIpcRenderer` 接口与 `IPC` 常量，不直接导入 `contextBridge`；导出 `createLive2dWorkApi(ipcRenderer)` 返回纯接口对象，由 `index.ts:1036` 统一执行 `contextBridge.exposeInMainWorld("live2dWork", createLive2dWorkApi(ipcRenderer))`。
   - 配套单测（`src/main/preload-live2d-work-api.test.ts`）无需 `vi.mock("electron")`，直接构造 fake `ipcRenderer` 即可测试全部返回值清洗与监听注销逻辑。
2. **先例 2 — 自暴露函数模式（`src/preload/music.ts`）**：
   - 文件内部导入 `{ contextBridge, ipcRenderer }` from `"electron"` 并导出 `exposeMusicApi(): void`，在 `index.ts:1257` 调用。
   - **既有测试绑定点**：`src/main/knowledge/skills/external-bridge.test.ts:7` 与 `external-integration.test.ts:22` 已通过 `vi.mock("../../../preload/music", () => ({ exposeMusicApi: vi.fn() }))` 屏蔽该模块。

---

## 2. 拆分边界

### 2.1 边界划分与实现约定

1. **按“功能域 + `window.*` 暴露对象内聚性”拆分**：
   - 约 30 个对象中，体量较小（10–40 行）且同属同一业务流程的桥按业务域合入同一文件（如 `plugins` 与 `pluginPanel` 归入 `plugins.ts`；`review`、`workspaceFiles`、`openInApp`、`codeGit` 归入 `workspace.ts`）。
   - 唯独 `settingsApi`（约 370 行、跨越设置弹窗与聊天页运行时审批两套窗口）单独拆为 `src/preload/settings/` 子目录下的 4 个按职能划分的构造器，再拼装成同一个 `window.settings` 对象。
2. **统一沿用 `live2d-work-api.ts` 的纯工厂模式（`create*Api(ipcRenderer, ...)`）**：
   - 子模块不直接调用 `contextBridge.exposeInMainWorld`，而导出 `create*Api(ipcRenderer)` 工厂（`createChatApi` 额外接收 `webUtils` 的受限接口，`createChatStoreApi` 接收 `pageTargetKey`）。
   - `index.ts` 作为全仓唯一且集中的 `contextBridge.exposeInMainWorld(...)` 装配清单（连同既有 `exposeMusicApi()` 调用），一眼可读全部暴露面，也避免给每个文件都引入 `electron` 上下文耦合。
3. **关键静态扫描兼容边界（硬约束）**：
   - `src/main/app/ipc-contract-scanner.ts:50-75` 以 AST 规则静态验证主进程与预加载通道一致性，要求每次跨进程调用**必须满足**：调用对象标识符名为 `ipcRenderer`，且第 1 个实参字面量为 `IPC.<KEY>`（例如 `ipcRenderer.invoke(IPC.SETTINGS_GET_CONFIG)`）。
   - 因此，**禁止**抽取类似 `function subscribe(channel: string, cb)` 这样把 `channel` 作为形参传入 `ipcRenderer.on(channel, ...)` 的通用辅助函数；否则静态扫描会漏检 `preload` 侧 `listen` 通道，导致 `ipc-contract.test.ts` 中 `outbound` 对齐检查报错。
   - 同时，已拆出的 `music.ts` 与 `memory-openrouter-once.ts` 本次保持原位与原导出不变，不破坏现有外部测试里的 `vi.mock("../../../preload/music")`。

### 2.2 备选方案对比（及不选原因）

| 方案 | 做法 | 不选原因 |
| --- | --- | --- |
| **方案 A（推荐）**：12 个域模块（含 `settings/` 子目录）导出 `create*Api(ipcRenderer)`，`index.ts` 集中 `exposeInMainWorld` | 保留 `live2d-work-api.ts` 注入约定；`settingsApi` 拆为 4 个内部切片再组合；所有 `ipcRenderer.<op>(IPC.*)` 调用形态不变 | **选中**：暴露清单集中在 `index.ts` 易于安全审计；新子模块免 `electron` mock 可单测；100% 兼容 `ipc-contract-scanner.ts` |
| **备选 1（不选）**：按 1 对象 = 1 文件，全部效仿 `music.ts` 直接调 `contextBridge.exposeInMainWorld` | 在 `src/preload/` 下平铺约 30 个只暴露单个对象的 `expose*.ts` 文件 | 产生近 30 个零碎文件（大量不足 25 行）；`exposeInMainWorld` 散落各处降低安全审查可读性；每个单测都必须 mock Electron `contextBridge` |
| **备选 2（不选）**：抽象通用监听器/调用器 helper（如 `onIpc(channel, wrap)`）去重样板代码 | 用通用 helper 包裹 `ipcRenderer.on` / `ipcRenderer.off` 与 `removeListener` | 直接触发 `ipc-contract-scanner.ts:11,69-75` 的静态求值限制（参数 `channel` 不算 `IPC.<KEY>`），导致全仓 IPC 契约测试失效；且 `off`/`removeListener` 行为混合时容易破坏现有 `preload-*` 测试 mock |
| **备选 3（不选）**：按窗口类型拆成多份 preload 入口（`chat-preload.ts`、`settings-preload.ts` 等） | 为每个 `BrowserWindow` 生成独立的 `dist/preload/*.js` 只注入各自所需桥 | 需要改动 `main` 层窗口创建、Vite/构建与类型检查流程，属于窗口安全架构演进而非纯文件拆分，超出本任务边界 |

---

## 3. 拆完后的结构

### 3.1 目录与导出函数签名

新增模块全部位于 `src/preload/` 下（完全落在 `tsconfig.preload.json` 与 `ipc-contract.test.ts` 扫描范围内，且仅从 `../shared/*` 或 `electron` 导入类型与常量）：

| 模块路径 | 涵盖 `window.*` | 导出函数签名与说明 |
| --- | --- | --- |
| `src/preload/pet.ts` | `firefly` | `export function createFireflyApi(ipcRenderer: Electron.IpcRenderer)`（与现有 `live2d-work-api.ts` 并列负责桌宠窗） |
| `src/preload/window-shell.ts` | `appUpdate`, `sidebar`, `toast` | `export function createAppUpdateApi(ipcRenderer: Electron.IpcRenderer): AppUpdateApi`<br>`export function createSidebarApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createToastApi(ipcRenderer: Electron.IpcRenderer): ToastRendererApi` |
| `src/preload/chat-media.ts` | `chat`, `desktopAsr`, `choice` | `export interface WebUtilsPathReader { getPathForFile(file: File): string }`<br>`export function createDesktopAsrApi(ipcRenderer: Electron.IpcRenderer): DesktopAsrApi`<br>`export function createChatApi(ipcRenderer: Electron.IpcRenderer, webUtils: WebUtilsPathReader)`<br>`export function createChoiceApi(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/agui.ts` | `agui`, `chatStore` | `export function createAguiApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createChatStoreApi(ipcRenderer: Electron.IpcRenderer, pageTargetKey: string)` |
| `src/preload/appearance.ts` | `fireflyTheme`, `fireflyFont`, `fireflyAppearance`, `stickerManager` | `export function createFireflyThemeApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createFireflyFontApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createFireflyAppearanceApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createStickerManagerApi(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/plugins.ts` | `plugins`, `pluginPanel` | `export function createPluginsApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createPluginPanelApi(ipcRenderer: Electron.IpcRenderer): PluginPanelApi` |
| `src/preload/scheduler.ts` | `fireflyScheduler`, `schedulerEvents` | `export function createSchedulerApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createSchedulerEventsApi(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/model-config.ts` | `modelConfig`, `tokenUsage` | `export function createModelConfigApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createTokenUsageApi(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/browser.ts` | `manualBrowser`, `manualBrowserWorkspace` | `export function createManualBrowserApi(ipcRenderer: Electron.IpcRenderer): BrowserAvailabilityApi`<br>`export function createManualBrowserWorkspaceApi(ipcRenderer: Electron.IpcRenderer): ManualBrowserWorkspaceApi` |
| `src/preload/memory-user.ts` | `user`, `memoryPanel`, `memoryAutomation` | `export function createUserApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createMemoryPanelApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createMemoryAutomationApi(ipcRenderer: Electron.IpcRenderer): MemoryAutomationPanelApi` |
| `src/preload/workspace.ts` | `review`, `workspaceFiles`, `openInApp`, `codeGit` | `export function createReviewApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createWorkspaceFilesApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createOpenInAppApi(ipcRenderer: Electron.IpcRenderer)`<br>`export function createCodeGitApi(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/settings/core.ts` | `settings`（配置/档案/模型/字体/桌宠/向量重排） | `export function createSettingsCoreMethods(ipcRenderer: Electron.IpcRenderer)`（含 `WireTransport` 等局部类型） |
| `src/preload/settings/extensions.ts` | `settings`（贴纸/工具/`externalSkills`/技能/MCP） | `export function createSettingsExtensionMethods(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/settings/channels.ts` | `settings`（外部渠道控制/日志/上下文/微信扫码事件） | `export function createSettingsChannelMethods(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/settings/approvals.ts` | `settings`（权限档位/Plan/运行审批/PopQuiz/截图快捷键） | `export function createSettingsApprovalMethods(ipcRenderer: Electron.IpcRenderer)` |
| `src/preload/settings/index.ts` | `settings` 总装配 | `export function createSettingsApi(ipcRenderer: Electron.IpcRenderer)`，通过对象展开 `{ ...core, ...extensions, ...channels, ...approvals }` 返回与原 `settingsApi` 完全同构的对象 |

> **说明**：参数类型 `Electron.IpcRenderer` 在需要脱离 Electron 运行的单元测试里也可简化成各模块所需的最小结构子类型（类似 `live2d-work-api.ts` 的 `Live2dWorkIpcRenderer`），从而在单测内无需构造完整的 `Electron.IpcRenderer`。

### 3.2 拆分后 `src/preload/index.ts` 保留内容

拆分后的 `src/preload/index.ts` 预计约 **55–65 行**，只做 3 件事：
1. 从 `electron` 导入 `{ contextBridge, ipcRenderer, webUtils }` 及所有 `create*Api`、`createLive2dWorkApi`、`exposeMusicApi`。
2. 生成当前渲染页唯一识别键 `const pageTargetKey = crypto.randomUUID();`。
3. 依次调用全部 **30 次** `contextBridge.exposeInMainWorld(name, factory(...))`（保留原有全局名）与末尾 `exposeMusicApi()`。

### 3.3 渲染进程类型声明如何保持不变

- 目前渲染进程接口类型分布在：`src/shared/*.ts`（共享契约接口，如 `AppUpdateApi`、`DesktopAsrApi`、`BrowserAvailabilityApi`、`ManualBrowserWorkspaceApi`、`PluginPanelApi`、`MemoryAutomationPanelApi`、`ToastRendererApi`）、[global.d.ts](file:///E:/Codex/Firefly/firefly-r5-preload/src/renderer/global.d.ts)（声明 `window.settings`、`chat`、`toast`、`plugins`、`modelConfig`、`manualBrowser*` 等）、[firefly.d.ts](file:///E:/Codex/Firefly/firefly-r5-preload/src/renderer/types/firefly.d.ts)（`window.firefly`）、[chat-page-bridge.ts](file:///E:/Codex/Firefly/firefly-r5-preload/src/renderer/react/features/chat/pages/chat-page-bridge.ts)（`ChatStoreApi`、`AguiApi`、`SettingsApprovalApi` 等）以及个别文件的局部 `declare global { interface Window }`（`main.ts`、`sidebar.ts`、`ui/theme.ts`、`settings/settings.ts`）。
- **类型不变约束**：
  1. 以上所有渲染进程与 `src/shared/*` 中的 `Window` 类型声明均**原地保持不变**；
  2. 新拆出的 `src/preload/*.ts` 仅允许依赖 `../shared/*` 与 Electron 类型，严禁引用 `src/renderer/*` 或 `src/main/*`（受 `src/shared/process-boundary.test.ts` 与 `tsconfig.preload.json` 双重保护）；
  3. 本设计不引入任何新增方法或改名方法，因此 `tsc -p tsconfig.renderer.json` 对外可见的 `Window` 契约零变化。

---

## 4. 安全边界与副作用

### 4.1 暴露面与边界不变量逐条核对

1. **暴露键全集完全一致**：
   - 全局键共 31 个：`desktopAsr`、`firefly`、`appUpdate`、`chat`、`agui`、`schedulerEvents`、`choice`、`sidebar`、`toast`、`fireflyTheme`、`fireflyFont`、`fireflyAppearance`、`settings`、`plugins`、`pluginPanel`、`fireflyScheduler`、`stickerManager`、`modelConfig`、`manualBrowser`、`manualBrowserWorkspace`、`user`、`memoryPanel`、`memoryAutomation`、`live2dWork`、`chatStore`、`review`、`workspaceFiles`、`openInApp`、`codeGit`、`tokenUsage`、`music`。
   - 嵌套命名空间保持不变：`settings.externalSkills`（`list`/`detail`/`prepare`/`commit`/`cancel`）与 `chatStore.sidebarLayout`（`get`/`mutate`/`onChanged`）。
   - 已退役表面绝不回流：`moments`、`call`、`openCall`、`LEGACY_WINDOW_API_NAMES`、`manualBrowser.grant`、`manualBrowserWorkspace.grant`、`memoryPanel.bindActor/event/source` 均保持禁止暴露。
2. **参数校验、默认值与字段过滤保持原样**：
   - `chat.ingestDroppedFiles`（原 L124–141）：只调用 `webUtils.getPathForFile`，异常吞并，仅构造 `{ path, mime }`，空数组不发 `IPC.CHAT_INGEST_FILES`；不向渲染层暴露原生 `FileSystem` 能力。
   - `chat.getImageSendStrategy`（原 L148–150）：无参/空串走 `undefined`，非空映射 `{ sessionId }`。
   - `fireflyAppearance.get` / `onChanged`（原 L359–372）：保留 `normalizeChatDisplay(...)` 归一化，防止异常结构直通渲染层 CSS。
   - `settings.externalSkills`（原 L520–544）：`list` 保持 `refresh = false` 默认值；`detail` 与 `prepare` 仅按 `{ sourceId, id, ...(selection === undefined ? {} : { selection }) }` 裁剪，不透传任意对象。
   - `settings.channelsLogGet`（原 L609–611）：保持 `limit ?? 100` 默认值。
   - `choice.resolve`（原 L263–267）：维持 `typeof settingValue === "string"` 判断。
   - `manualBrowser` & `manualBrowserWorkspace`（原 L873–958）：维持 `withTab` 条件键注入与 `{ kind }` 指令白名单。
   - `chatStore.create`（原 L1066–1073）保持 `message ?? {}`、`pendingEdit`（L1112–1124）保持条件写入 `userSticker`、`setActiveSession`（L1138–1140）维持空键直传 `null` / 非空附加 `rendererTargetId: pageTargetKey`、`codeGit.switchBranch`（L1218–1220）保持 `create = false` 默认值。
   - `live2dWork`（`live2d-work-api.ts`）：保持非 boolean 转 `false` 与异常兜底。
3. **事件监听注册与注销行为不丢、不混改**：
   - `index.ts` 中全部 34 处（加上 `live2dWork` 共 35 处）事件监听方法均保留“构造局部 `forwardEvent` 剥去 `_ipcEvent` 参数 + 注册该 `forwardEvent` + 返回卸载同一 `forwardEvent` 的 `() => void`”。
   - 保持各自原本使用的注销 API（`off` 或 `removeListener`）不变；特别是 `manualBrowser*`、`modelConfig`、`toast`、`chatStore`、`codeGit`、`live2dWork` 以及 `settings` 下的计划/审批/PopQuiz 当前全部使用 `removeListener`，拆分搬移中不得擅自替换为 `off`（部分主进程测试 mock 未定义 `off`），统一梳理应留作独立回归提交。
   - `agui.onEvent` 与 `schedulerEvents.onEvent` 保留回调内 `try/catch` + `console.error` 异常隔离。

### 4.2 自动化暴露面与通道双比对机制

1. **静态全量通道 & 禁用词扫描扩展**：
   - 已有 `src/main/app/ipc-contract.test.ts:18` 已经对 `src/preload` 做递归扫描，确保拆分后每条 `invoke` / `send` / `listen` 依然与主进程一一配对；
   - 需把 `ipc-contract.test.ts:46-49` 与 `src/main/structure-cleanup.test.ts:25` 从仅读 `src/preload/index.ts` 扩展为递归遍历 `src/preload/**/*.ts`（排除测试文件），确保退役关键词检查覆盖全部新拆出的文件。
2. **运行时暴露键集合与通道快照守卫（`src/preload/exposure-surface.test.ts`）**：
   - 拆代码前，先在基线 `a96f254` 导入原 `src/preload/index.ts`，记录 **31 个 `window.*` 对象**、每个对象的排序键名列表（含嵌套命名空间 `externalSkills` 与 `sidebarLayout`）以及逐方法调用命中的精确 `IPC` 通道名与方式（`invoke` / `send` / `on`）作为锁定契约表；
   - 拆分过程中每完成一次迁移，直接针对实际运行后的 `index.ts` 比对完整快照对象与通道表：多 1 个键、少 1 个键或任一方法改了通道字符串，测试立即失败。

---

## 5. 测试保护

### 5.1 已有测试与覆盖盘点

通过 `git grep` 与实际运行验证（关联的 8 个测试文件 / 62 条测试均通过），当前与 preload 相关的测试如下：

| 测试文件 | 覆盖范围与特点 |
| --- | --- |
| `src/main/app/ipc-contract.test.ts` | **全目录静态契约**：递归扫描 `src/preload/`，断言 preload `invoke`/`send`/`listen` 与主进程 `handle`/`on`/`outbound` 精准对齐；第 46 行单文件读 `src/preload/index.ts` 检查未暴露 `moments`/`call`/`openCall` |
| `src/shared/process-boundary.test.ts` | **边界防回流**：AST 检查 `src/preload/` 生产代码不引用 `src/main/` |
| `src/main/structure-cleanup.test.ts` | 第 25 行读 `src/preload/index.ts`，检查不包含 `LEGACY_WINDOW_API_NAMES` |
| `src/main/preload-live2d-work-api.test.ts` | `createLive2dWorkApi` 单元测试（状态快照、失败兜底、非 boolean 转换、注销停发） |
| `src/main/platform/windows/preload-browser-workspace.test.ts` | mock `electron`（注意仅 mock `on`/`removeListener`，无 `off`），测 `manualBrowserWorkspace` 方法、无 `grant` 及 `onChanged`/`onToolsChanged` 注销 |
| `src/main/platform/windows/preload-model-connection.test.ts` | mock `electron`（无 `off`），测 `modelConfig.getConnectionSnapshot`/`onConnectionChanged`、`manualBrowser` 权限/命令与无 `grant`、`sidebar.openSettings`、`fireflyTheme.getColors`/`onColorsChanged` |
| `src/main/knowledge/skills/external-bridge.test.ts`<br>`external-integration.test.ts` | mock `../../../preload/music`，测 `settings.externalSkills` 5 个方法载荷过滤与 `settings.setSkillEnabled` 通道 |
| `src/main/memory/policy/memory-settings-ipc.test.ts` | 第 193–200 行测 `memoryPanel.getState`/`applyAction`/`auditSource` 通道及不暴露 `bindActor`/`event`/`source` |

**保护缺口**：其余 23 个暴露对象（如 `desktopAsr`、`firefly`、`appUpdate`、`chat`、`agui`、`schedulerEvents`、`choice`、`toast`、`fireflyFont`、`fireflyAppearance`、`plugins`、`pluginPanel`、`fireflyScheduler`、`stickerManager`、`user`、`memoryAutomation`、`chatStore`、`review`、`workspaceFiles`、`openInApp`、`codeGit`、`tokenUsage`、`music`）及 `fireflyTheme` / `settings` / `memoryPanel` 中的绝大多数方法与事件注销尚无行为单元测试。

### 5.2 拆前必补测试（遵循 `AGENTS.md` 测试断言规范）

在搬动任何代码前先补齐以下 5 组测试（严格使用全对象/全集合断言、负向调用检查、表驱动契约测试与 fake `ipcRenderer`，不写“不报错即通过”）：

1. **T1 暴露面完整键集合与禁止面不变量测试**（规则 2、10）：
   - `Object.keys(exposed).sort()` 必须完全等于 31 个全局名列表；每个暴露对象及嵌套对象 `settings.externalSkills`、`chatStore.sidebarLayout` 的排序方法名数组与锁定基线全等；不存在 `grant`、`moments`、`call`、`LEGACY_WINDOW_API_NAMES`。
2. **T2 未覆盖域表驱动“方法 → 通道 → 参数”映射测试**（规则 2、5、7）：
   - 对 `desktopAsr`、`firefly`、`appUpdate`、`choice`、`sidebar`、`toast`、`plugins`、`pluginPanel`、`fireflyScheduler`、`stickerManager`、`user`、`memoryAutomation`、`review`、`workspaceFiles`、`openInApp`、`codeGit`、`tokenUsage`、`music` 及 `settings`（配置/档案/模型/字体/宠物/工具/技能/MCP/渠道/权限/Plan/PopQuiz/截图热键）的每个方法建立表驱动用例，断言只调用 1 次目标 `ipcRenderer.invoke` 或 `send`，且通道常量名与透传/封装参数体完整匹配。
3. **T3 参数裁剪、归一化与安全过滤边界测试**（规则 2、4、10）：
   - **`chat.ingestDroppedFiles`**：`File[]` 中某项 `webUtils.getPathForFile` 抛异常时不中断、被跳过；全空或全异常时 `ipcRenderer.invoke` 调用次数为 `0`（负向断言）；正常数组仅向 `IPC.CHAT_INGEST_FILES` 传入 `[{ path, mime }]`。
   - **`fireflyAppearance`**：`get()` 与 `onChanged()` 接收缺失字段或越界值时，输出完全等于 `normalizeChatDisplay(...)` 归一化结果，原始非法属性不透传。
   - **`choice.resolve`**：分别传入 `"ok"` 与 `{ chosen: 1 }`，精确断言入参转为 `{ id, value: "ok" }` 与 `{ id, answer: { chosen: 1 } }`。
   - **`chatStore` 状态键与可选字段**：同一 `index.ts` 导入期内连续两次调用 `chatStore.setActiveSession("s1", "work")`，断言第 1 次生成的 UUID `rendererTargetId` 与第 2 次严格相等且为合法 UUID，传入 `null` 时向通道传 `null`；调用 `pendingEdit` 不传 `userSticker` 时传入载荷 `Object.keys` 不包含 `"userSticker"`。
   - **`agui.onEvent` / `schedulerEvents.onEvent`**：回调抛出异常时错误被记录且不向外抛出打断后续投递。
4. **T4 全部 34 处 `index.ts` 事件监听的载荷解包与精确注销测试**（规则 4、5、7）：
   - fake `ipcRenderer` 同时提供 `on`、`off`、`removeListener` 并追踪各通道 listener 集合；触发事件 `(_ipcEvent, payload)` 时断言回调只接收 `payload` 且不泄漏 `_ipcEvent`；调用返回的 `unsubscribe()` 后，同通道存在其他存活监听时仅精准移除自己、再 emit 同通道事件原回调不再被调用（调用次数停留在 `1`）。
5. **T5 静态扫盘范围扩展**（配合 PR 1 收口）：
   - 将 `src/main/app/ipc-contract.test.ts:46` 与 `src/main/structure-cleanup.test.ts:25` 更新为递归读取 `src/preload/` 下全部非测试 `.ts` 文件进行禁词/退役接口校验。

---

## 6. 实施批次与提交顺序

拆分全程坚持 **先测试锁定，再小步搬移；结构搬移与 bug/风格修正严格分离**。每个 Commit 单独检出均必须通过 `npm run build:preload`（`tsc -p tsconfig.preload.json`）及相关测试。

| PR | 目标 | Commit 顺序 | 说明与纪律要求 |
| --- | --- | --- | --- |
| **PR 1** | **建立暴露面锁定与补全保护测试** | **C1**：新增 `src/preload/exposure-surface.test.ts`（覆盖 T1 全量键集合与 T2 表驱动通道映射）<br>**C2**：补充输入过滤、归一化与全量 `on*` 注销单测（T3–T4）<br>**C3**：扩展 `ipc-contract.test.ts:46` 与 `structure-cleanup.test.ts:25` 为扫描整个 `src/preload/`（T5） | 纯测试补齐与防线加固，不改任何 `src/preload/*.ts` 生产代码 |
| **PR 2** | **搬移 `settings` 之外的全部外围域** | **C4**：抽出 `src/preload/window-shell.ts` 与 `src/preload/pet.ts`<br>**C5**：抽出 `src/preload/chat-media.ts` 与 `src/preload/appearance.ts`<br>**C6**：抽出 `src/preload/plugins.ts`、`src/preload/scheduler.ts` 与 `src/preload/model-config.ts`<br>**C7**：抽出 `src/preload/browser.ts` 与 `src/preload/memory-user.ts`<br>**C8**：抽出 `src/preload/agui.ts` 与 `src/preload/workspace.ts` | 纯搬移，保持每处 `off` / `removeListener` 原本写法与参数校验完全不变，同时让既有 `ipc-contract.test.ts` 保持 0 缺口 |
| **PR 3** | **拆解 `settingsApi` 并收敛 `index.ts`** | **C9**：建立 `src/preload/settings/core.ts` 与 `src/preload/settings/extensions.ts`<br>**C10**：建立 `src/preload/settings/channels.ts`、`approvals.ts` 与 `settings/index.ts`，将 `src/preload/index.ts` 收敛为纯装配入口 | 完成后 `index.ts` 只剩依赖注入与 `contextBridge.exposeInMainWorld` 调用；可另开后续独立 PR 再评估统一 `off`/`removeListener` 及整理渲染侧散落的 `Window` 类型声明，不混入本系列 PR |

---

## 7. 风险与回退

### 7.1 主要风险与规避

1. **`ipc-contract-scanner.ts` 对抽象封装失明导致契约误报**：
   - *风险*：如果拆出模块里把 `IPC.<KEY>` 存进变量/配置数组后再传给 `ipcRenderer.invoke(ch)`，AST 静态扫描无法提取常量键名，`ipc-contract.test.ts` 会立即报主进程多出未配对的 `handle` / `outbound`。
   - *规避*：坚持零动态通道传参，所有调用保留直接字面写法 `ipcRenderer.<method>(IPC.<KEY>, ...)` 与 `MANUAL_BROWSER_WORKSPACE_IPC.*` / `SIDEBAR_LAYOUT_IPC.*`（注意：`ipc-contract-scanner` 只识别 `IPC.*` 标识符，既有的 `MANUAL_BROWSER_WORKSPACE_IPC` 与 `SIDEBAR_LAYOUT_IPC` 原样保持即可）。
2. **既有测试 `electron` mock 缺少 `off` 方法导致运行时报错**：
   - *风险*：`preload-browser-workspace.test.ts`、`preload-model-connection.test.ts`、`external-bridge.test.ts` 的 `electron` mock 仅定义了 `ipcRenderer.removeListener`，未定义 `ipcRenderer.off`。若搬移过程中顺手把原有的 `removeListener` 改成 `off`，一旦测试调用注销函数会直接 `TypeError: ipcRenderer.off is not a function`。
   - *规避*：PR 2 与 PR 3 严格遵循“原来写 `off` 的保留 `off`，原来写 `removeListener` 的保留 `removeListener`”；新增测试 mock 同时提供 `off` 与 `removeListener`。
3. **误引用 `src/renderer/*` 或 `src/main/*` 导致编译/边界测试失败**：
   - *风险*：`settingsApi` 类型原本声明在 `src/renderer/settings/shared/types.ts`，若新模块 `import type { SettingsApi }`，虽不一定打包进运行时但会破坏进程分层原则且超出 `tsconfig.preload.json` 的 `include` 范围（仅 `src/preload/**/*.ts` 与 `src/shared/**/*.ts`）。
   - *规避*：新 `src/preload/**` 文件只准引用 `../shared/*` 与 `electron`，不引用 `src/renderer` 或 `src/main`，每次提交必跑 `npm run build:preload` 与 `process-boundary.test.ts`。
4. **`pageTargetKey` 退化为每次调用重生成**：
   - *风险*：若在 `createChatStoreApi` 内部把 `crypto.randomUUID()` 写进 `setActiveSession` 方法体而非初始化一次，会导致同一个渲染窗口激活会话标识漂移。
   - *规避*：维持在 `index.ts` 模块顶层（或 `createChatStoreApi` 工厂构造期）生成一次并经 T3 单测守住同一实例多次调用返回相同 `rendererTargetId`。
5. **`preload/music.ts` 与既有测试 mock 耦合**：
   - *风险*：`external-bridge.test.ts` 与 `external-integration.test.ts` 直接 mock 了 `"../../../preload/music"` 的 `exposeMusicApi`。
   - *规避*：`music.ts` 文件路径和导出名 `exposeMusicApi` 原封不动，保留在 `index.ts` 末尾调用。

### 7.2 回退方案

- PR 1 无生产代码改动，可直接丢弃；PR 2 与 PR 3 按域逐 Commit 拆分，任一域出现兼容问题可在当前分支对单个 Commit 执行 `git revert <sha>` 将对应对象内联回 `src/preload/index.ts`，零外部构建或运行配置改动。

---

## 8. 验证方法

### 8.1 自动化检查命令（均来自 `package.json` 真实脚本）

每次提交后在仓库根目录执行（Windows PowerShell 需加 `NODE_OPTIONS` 关闭实验性 WebStorage）：

1. **Preload 编译检查（每次提交必跑）**：
   - `npm run build:preload`（执行 `tsc -p tsconfig.preload.json`）
2. **Preload 契约、暴露面与关联单测（每次提交必跑）**：
   - `$env:NODE_OPTIONS='--no-experimental-webstorage'; npx vitest run src/preload src/main/app/ipc-contract.test.ts src/shared/process-boundary.test.ts src/main/structure-cleanup.test.ts src/main/preload-live2d-work-api.test.ts src/main/platform/windows/preload-browser-workspace.test.ts src/main/platform/windows/preload-model-connection.test.ts src/main/knowledge/skills/external-bridge.test.ts src/main/memory/policy/memory-settings-ipc.test.ts`
3. **三端编译与全仓构建（每个 PR 合入前必跑）**：
   - `npm run check:renderer`（`tsc -p tsconfig.renderer.json`）
   - `npm run build`（含 `check:storage-boundary`、`build:clean`、`build:main`、`build:preload`、`build:cli`、`build:renderer`）
4. **全量测试回归（每个 PR 合入前必跑）**：
   - `$env:NODE_OPTIONS='--no-experimental-webstorage'; npm test`（执行 `node scripts/testing/run-tests.mjs`）

### 8.2 Electron 真实应用联调检查项（PR 2、PR 3 合入前执行）

1. **聊天与 Agent 主流程（`chat`、`agui`、`chatStore`、`choice`、`fireflyAppearance`）**：新建/切换/重命名会话并持久化，拖拽文件进输入框成功触发 `ingestDroppedFiles`，发送对话收到流式事件与工具审批/PopQuiz 卡片、提交选择正常，截图插入正常，修改字号/排版实时同步无报错，切换工作区与 Code 模式查看 Git 状态/提交正常。
2. **桌宠、Live2D、侧栏与提醒窗（`firefly`、`live2dWork`、`sidebar`、`toast`、`appUpdate`）**：桌宠窗口拖动/穿透/缩放联动正常且任务执行时切换工作中状态，侧栏置顶/打开设置页指定分类正常，系统通知弹窗点击与关闭正常。
3. **设置中心与扩展窗口（`settings`、`plugins`、`fireflyScheduler`、`stickerManager`、`manualBrowser*`、`memoryPanel`、`music`）**：打开设置页全部板块读写与保存生效、外部技能浏览与安装正常、微信扫码/渠道日志推送实时刷新、贴纸管理器独立小窗开关贴纸生效、受控浏览器多标签页打开与权限撤回隔离生效、记忆导入与审计正常、QQ 音乐状态控制正常。

## 负责人决定（hotaru，2026-11-15）

1. 新拆出的模块统一写成 `create*Api(ipcRenderer)` 工厂函数，由 `index.ts` 集中调用 `contextBridge.exposeInMainWorld`；`music.ts` 保持自暴露，因为现有测试直接 mock 它。
2. 不做通用的事件监听封装，各模块保留字面写法 `ipcRenderer.<op>(IPC.<KEY>)`，契约扫描器才能认出通道。
3. `off` / `removeListener` 统一成一种写法，在拆分之前先单独做一个修复 PR。拆分时按统一后的写法搬移。
