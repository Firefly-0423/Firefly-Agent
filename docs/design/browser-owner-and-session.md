# 浏览器持有者拆分、本地登录态持久化与相关问题设计

状态：负责人已定（日期 2026-11-17），待施工
实现状态：未实现（已定稿设计，见[施工计划](../superpowers/plans/browser-owner-and-session.md)）

日期：2026-11-17
核对基线：`dev/firefly-1.2.0` `@ 633eb36`（含 PR #95 `feat/run-lifecycle`）。本文依据当前源码、既有测试、`package.json` 中的 Electron `43.7.0` 声明/二进制 fuse 信息与 `react-resizable-panels` `4.12.4` 实现核对整理；未运行实时 Electron/Chromium 启动、端到端拖拽或打包产物验证，依赖运行时验证的行为均显式标注“待核实”。

---

## 一、现状调查

### 1.1 浏览器持有者（Owner）类型、创建、绑定对象与失效时机

当前主进程存在两套互不合并的浏览器持有者，都在主窗口创建回调 `bindBrowserHost`（`src/main/app/default-dependencies.ts:575-599`）中绑定到唯一 Chat `BrowserWindow` 上，分别服务“会话内浏览器 / Agent 浏览器”与“窗口级多标签手动浏览器工作区”：

| 维度 | 会话绑定型 Owner（Agent 与单会话手动兼容） | 窗口工作区多标签型 Owner（普通手动浏览） |
|---|---|---|
| 创建入口 | `registerBrowserHostOwner`（`src/main/platform/browser/browser-host-owner.ts:9-41`） | `registerManualBrowserHostOwner`（`src/main/platform/browser/browser-host-owner.ts:44-92`）+ `createManualBrowserWorkspace`（`src/main/platform/browser/manual-browser-workspace.ts:19-81`） |
| 服务实例 | `browserService`（`src/main/app/default-dependencies.ts:494-506` 懒创建，通道 `IPC.BROWSER_PERMISSION` / `IPC.BROWSER_COMMAND`，见 `src/main/platform/browser/browser-service-ipc.ts:13-21`） | `manualBrowserService`（`src/main/app/default-dependencies.ts:570-572`，在 `createManualBrowserWorkspace` 内部通过 `addTab` 为**每个标签分配独立的 `createBrowserService` 实例**与派生子 Owner，见 `manual-browser-workspace.ts:35, 68-79`；通道 `MANUAL_BROWSER_WORKSPACE_IPC.*`，见 `browser-service-ipc.ts:24-32`） |
| 绑定对象 | `{ host, topFrame: host.webContents.mainFrame, profile, conversationId: target.sessionId, ownerSessionId, generation, signal }`（`browser-host-owner.ts:29-30`） | 父 Owner：`{ host, topFrame: contents.mainFrame, profile, conversationId: null, workspaceId, ownerSessionId, generation, signal }`（`browser-host-owner.ts:60-62`）；每个标签通过 `addTab` 复制父 Owner 并派生子 `AbortController`（上限 8 个标签，`manual-browser-workspace.ts:68-81`） |
| 刷新触发 | `resolveOwner`（要求 `event.sender === host.webContents && event.senderFrame === mainFrame`，`browser-host-owner.ts:33-36`）以及切会话时 `onActiveTargetChanged` 显式调用 `browserHost?.binding.refresh()`（`default-dependencies.ts:810-815`） | `resolveOwner`（`browser-host-owner.ts:65-70`），不订阅 `activeChatTargetRegistry`（切换聊天会话或模式时保持窗口工作区网页与授权，`electron-browser-service.ts:40` 提示文案亦如此约定） |
| 失效 / 吊销时机 | 1. 活跃目标变化：`targetKey`（`[sessionId, mode, rendererTargetId]`）或 `mainFrame` 变化时先 `invalidate()` 再新建，旧 `signal` abort 并调 `service.revoke(previous)`（`browser-host-owner.ts:15-18, 26-28`）；<br>2. 目标缺失/校验失败或已删除（`browser-host-owner.ts:23-25`）；<br>3. `targets.onInvalidated` 命中当前窗口时 `invalidate()`（`L38`）；<br>4. `targets.onSessionDeleted` 命中 `owner.conversationId` 时 `invalidate()`（`L39`）；<br>5. 窗口 `closed` / `dispose()`（`default-dependencies.ts:593-598`、`browser-host-owner.ts:40`）。 | 1. 主框架非同文档导航：`did-start-navigation`（`isMainFrame && !isSameDocument`，`browser-host-owner.ts:74-79`）置 `navigating = true` 并 `invalidate()`，旧标签授权与页面随父/子 `AbortSignal` 与 `service.revoke` 立即失效；而工作区记录表 `host.tabs` 的 `closeTabs()` 清理则在后续 `resolve()` 发现 `host.owner !== owner` 时完成（`manual-browser-workspace.ts:58-64`）；<br>2. `render-process-gone`（`L81`）；<br>3. `destroyed` / `closed` / `dispose()`（`L82-90`、`default-dependencies.ts:593-598`）。 |

**前端卸载自动吊销链路及触发范围：**

- `ManualBrowserTab`（`src/renderer/react/features/chat/workspace/ManualBrowserTab.tsx:64-71, 128-137`）既服务会话级通道（`window.manualBrowser`），也承载窗口工作区各标签（传入 `workspaceId` + `tabId` 时包装 `window.manualBrowserWorkspace`）。
- 在该组件真实卸载（React `useEffect` 清理且微任务确认非严格模式同 `ownerKey`/`tabId` 瞬时重挂载）时，会主动调用 `api?.revokePermission(...)`（`ManualBrowserTab.tsx:131-136`）。
- 注意：窗口工作区标签在 `BrowserWorkspaceTabs` 中采用 `hidden={...}` 保活设计，刻意在切换对话或更换 `active` 时保持挂载（`src/renderer/react/features/chat/workspace/BrowserWorkspaceTabs.tsx:11, 125-129`），因此“切换会话/面板就会卸载组件”并非对所有场景普遍成立；但一旦组件确实发生卸载（例如切会话导致会话型页卸载、或右栏整组退出挂载），就会触发权限撤销。

---

### 1.2 运行中的 Agent 浏览器工具调用如何解析、校验 Owner 及断链点

Agent 工具执行链路的接线与校验如下：

1. **注入入口**：`default-dependencies.ts:877-881` 将 `browserWorkspace` 注入 `registerAllTools`：
   - `currentOwner: () => browserHost?.binding.getCurrentOwner() ?? null`
   - `service: getBrowserService`
   - `isRunCurrent: isActiveConversationRun`
2. **执行器预校验**：`src/main/agent/tools/browser-workspace-executor.ts:12-21`：
   - 读取 `owner = options.currentOwner()`，要求存在、`owner.conversationId === conversationId`、`!owner.signal.aborted`，且 `options.isRunCurrent(conversationId, runId)` 为真；
   - 构造传给 `service.executeAgent` 的 `run.isCurrent` 闭包：要求 `!signal.aborted && !owner.signal.aborted && options.currentOwner() === owner && options.isRunCurrent(conversationId, runId)`。
3. **主服务门禁与并发保护**：`executeAgent`（`src/main/platform/browser/browser-service.ts:532-601`）：
   - `runCurrent()`（`L535-538`）再次校验 `current(owner)`（`L196-200` 内部调用 `owner.host.resolveOwner(owner.event) === owner.value`，同步刷新宿主绑定）以及 `run.isCurrent()`；
   - 校验当前授权必须是 `owner.grant?.mode === "agent"`（`L540`），并通过 `owner.agentBusy` 防止并发（`L549, L562, L600`）；
   - **强制窗口/面板可见性门禁（`L555, L571`）**：除 `"close"` 外，进入及动作前均校验 `hostVisible(owner)`（`!owner.pending && !entry.overlay && entry.visible && entry.focused && entry.host.isVisible() && entry.host.isFocused()`，`L263-266`），非 `"open"` 操作还校验 `presented(cell)`（`cell.attached && hostVisible(cell.owner)`，`L267`）；
   - **展示态一致性（`L572-578, L588`）**：`observe` 与 `click`/`type` 之间用 `samePresentation()` 比对 `presented(cell)` 和 `cell.presentationRevision === presentationRevision`（`detach(cell)` 会递增 `presentationRevision` 并清空 `cell.observation`，`L268-271`）；
   - **中止竞赛与收尾（`L558-559, L591-596`）**：监听 `run.signal`、`ownerValue.signal` 与 `cellSignal`，任一 `abort` 触发 `Promise.race` 返回 `cancelled`；而若在检查期间 `runCurrent()` 返回 `false`（如宿主绑定失效或非当前运行），也会执行 `cancel()` 清理并返回 `cancelled` 或 `owner_mismatch`（`L539, L596`）。

**以下用户行为会在精确位置打断上述链路（需严格区分“单次操作失败”、“授权撤销”与“整场 Run 取消”）：**

- **切换聊天会话（A -> B）**：
  1. `onActiveTargetChanged` 触发 `browserHost?.binding.refresh()`（`default-dependencies.ts:810-815`）；
  2. `registerBrowserHostOwner` 检测到 `targetKey` 变化调用 `invalidate()`（`browser-host-owner.ts:26-28`），abort 旧 `owner.signal` 并调用 `service.revoke(previous)`；
  3. 正在等待的 `executeAgent` 可能在 `Promise.race` 中返回 `cancelled`（`L591-594`）或因 `runCurrent()` 失败返回 `owner_mismatch`（`L539, L596`），同时调用 `cancel()` 清空授权与 `cells`；后续同一 Run 的工具调用会在 `browser-workspace-executor.ts:15` 因 `owner.conversationId !== conversationId` 被拒绝；切回 A 后生成新的 `generation`，原授权和页面不自动恢复；
  4. 若前端同时触发组件真实卸载，也会经 `ManualBrowserTab.tsx:131-136` 主动调用 `revokePermission`。
- **宿主页面导航/刷新**：
  - `activeChatTargetRegistry` 在主窗口发生主框架导航时触发 `onInvalidated`，`browser-host-owner.ts:38` 调用 `invalidate()` 吊销 `owner`（工作区同步通过 `did-start-navigation` 失效，见 `L74-79`）。
- **关闭窗口**：
  - `window.once("closed")`（`default-dependencies.ts:593-598`）触发 `binding.dispose()`/`manualBinding.dispose()`；`browser-service.ts:609-620` 监听 `host.closed` 与 `webContents.destroyed` 调用 `closeHost`，吊销 owner 并清理全部 `cell`。
- **窗口最小化 / 隐藏（`hide`）/ 失焦（`blur`）/ 遮罩层（`detach` 与 `terminate/cleanup` 的区别）**：
  - `browser-service.ts:604-606, 631` 监听宿主 `hide`、`blur` 以及 `setTrustedOverlay(..., true)`，把 `entry.visible = false` 或 `entry.focused = false` 并调用 `detach(cell)`（`L268-272`）。
  - **重要区分**：`detach(cell)` **只从主窗口摘除视图、置 `cell.attached = false`、递增 `presentationRevision` 并清空 `cell.observation`**，**并不销毁 `guest`、`Session`、也不撤销授权或主动终止 Agent Run**。
  - 在这种状态下：下一轮非 `"close"` 的 `executeAgent` 会被 `hostVisible`/`presented` 拦截返回 `permission_denied`（`L555`，见单元测试 `browser-service.test.ts:450-469`）；进行中的 `observe`/`click`/`type` 会因 `samePresentation()` 为假返回 `cancelled`（`L577, L588`）；但**已经发起的 `open` / `navigate` / `history` 操作**内部不再做 `samePresentation()` 二次可见校验（`L566-569`）；且授权本身未被 `detach` 直接撤销（仅阻塞操作，是否进而中止 Run 取决于 Agent 工具调用失败后的上层处理）。
  - 另需说明：`setTrustedOverlay()`（`browser-service.ts:631`）虽有实现与单元测试，但当前**未查到**生产代码调用方；前端自身面板上的下载/设置等覆盖层是通过 `ManualBrowserTab.tsx:298` 计算 `overlayOpen` 发出 `layout({ bounds: null })` 令主进程 `detach(cell)`，两者不应混写。

---

### 1.3 当前 Electron `session` / `partition` 构造、存储位置、权限与下载

- **Partition、缓存与生命周期清理**：
  - 主进程依赖 Electron `43.7.0`（`package.json:93`）。根据 `node_modules/electron/electron.d.ts:12477-12480, 13283-13297`，仅有 `persist:` 前缀的 partition 会落盘持久化（`isPersistent() === true`、`getStoragePath()` 返回目录路径），无该前缀的均为内存临时会话（`getStoragePath()` / `storagePath` 为 `null`）。
  - 当前 `browser-network-binding.ts:199` 每次准备浏览器域都生成无持久化前缀的随机名：`` `firefly-browser-${randomUUID()}` ``。
  - `electron-browser-service.ts:46` 传入 `{ cache: false }` 调用 `session.fromPartition(partition, { cache: false })`——注意 `{ cache: false }` 控制的是 **Chromium HTTP 磁盘缓存**，并非“是否保存 Cookie”的开关。
  - `browser-network-binding.ts:58` 读取计算 `persistent: session.storagePath !== null`；实际拒绝持久化 `Session` 与复用 `Session` 发生在 `browser-network-binding.ts:201`（`if (port.persistent || seen.has(port.session) || registry.hasSeenSession(port.session)) throw "permission_denied"`）；而 `browser-authorization-domain.ts:131` 只拦截重复 `Session`（`seen.has(session)`），本身不校验持久性。
  - `browser-network-binding.ts:159-162` 在 `cleanup`（关闭标签、撤销授权、切换权限或应用退出）时，调用 `closeAllConnections()`、`clearStorageData()`、`clearCache()`、`clearAuthCache()`、`clearHostResolverCache()`，并等待运行中 service worker 归零（`L164-172`）。因此当前 Cookie、LocalStorage、IndexedDB、Service Worker 与 HTTP Cache 全部不跨重启保存、标签间隔离、关闭即清。
- **应用数据目录与隔离基线**：
  - `src/main/base/identity/data-directory.ts:8`、`src/main/base/identity/runtime-profile.ts:54-57`：生产模式 `userData` 与 `sessionData` 均为 `<productionAppData>/Firefly-1.2.0`（Windows 下为 `%APPDATA%\Firefly-1.2.0`）。
  - `runtime-profile.ts:70-71, 96` 与 `src/main/base/identity/app-identity.ts:52, 60`：非生产隔离启动（`development` / `test` / `smoke`）将 `userData` 设为 `<isolationRoot>/Firefly-<kind>`、`sessionData` 设为 `<isolationRoot>/Firefly-<kind>/session` 并预检确认 Electron 确实采用了隔离路径。
- **Cookie 默认加密现状（Electron 43.7.0 / 本地构建实测）**：
  - Electron `43.7.0` 默认关闭 `cookieEncryption` fuse（`EnableCookieEncryption` 默认为 disabled，即 Cookie 值以明文写入存储）。
  - 只读读取本地依赖二进制 `node_modules/electron/dist/electron.exe` 中的 fuse 块已核实：`EnableCookieEncryption` 位为 ASCII `'0'`（即 `48`，关闭状态）。`electron-builder.yml:15` 配置了 `electronDist: node_modules/electron/dist`，但**发布安装包构建产物中是否保持或改动该 fuse 尚未检查，标注“待核实”**。
  - 虽然 `src/main/features/plugins/host/plugin-runtime.ts:1` 导入了 Electron `safeStorage`，但该导入与浏览器 Cookie 存储无关，**没有任何源码证据表明当前浏览器 Cookie 使用了 OS 密钥加密**。
- **Guest 沙箱、请求策略、认证与下载**：
  - `electron-browser-guest.ts:12-16, 36-43`：`WebContentsView` 开启 `sandbox: true`、`contextIsolation: true`、`webSecurity: true`，禁用 Node/Preload/webview/devTools/弹窗（`setWindowOpenHandler(() => ({ action: "deny" }))`）及非代理 UDP 的 WebRTC（`disable_non_proxied_udp`），拒绝证书错误（`rejectBrowserCertificate`）。
  - `browser-network-binding.ts:67-75`：拒绝所有 `PermissionCheck`、`PermissionRequest`、`DevicePermission`；`browser-service-ipc.ts:38-50`：`app.on("login")` 仅向已注册 guest 供应代理凭据，拒绝证书错误与客户端证书。
  - **请求过滤与账号路径拦截实际边界**：当前生产请求策略来自 `browser-authorization-domain.ts:171-184`（由 `browser-service.ts:201` 创建注册；独立函数 `createBrowserRequestPolicy` 所在 `browser-request-policy.ts` 在当前生产路径中**未查到**直接调用）。
    - 工作区普通浏览（`scope.web === true && owner.workspaceId !== undefined && scope.mode === "manual"`，`electron-browser-service.ts:19`）使用 `webMethods`（含 `POST`/`PUT`/`DELETE` 等）与 `webResources`（含 `webSocket`/`ping`/`other`，`browser-authorization-domain.ts:51-52`），允许正常公网网页交互。
    - 非 `web: true` 的会话型手动浏览（除本机/内网外）与 `mode: "agent"` 受 `browser-service.ts:103-114`（导航/链接 URL 校验调用 `isAccountPath`，**并非**对所有子资源/XHR 统一执行 `isAccountPath`）、以及隔离世界脚本 `browser-dom-script.ts:9-44` 中的 `SENSITIVE_FIELD_SOURCE` / `ACCOUNT_ACTION_LABEL_SOURCE` / `account` URL 检查约束。因此，敏感输入框与按钮文案拦截仅覆盖 Agent DOM 自动化脚本，不能保证原生手动网页禁止用户输入敏感信息。
  - **下载策略**：`browser-network-binding.ts:71-75`、`browser-service.ts:212-215` 仅在 `mode === "manual" && web === true` 时委托 `browser-downloads.ts:69-100` 校验 `hasUserGesture()`、文件总大小（`total > maxBytes`）、`updated` 事件中的累计已收字节上限（`received > maxBytes`，针对未知总大小下载，`L88-92`）、并发上限与安全文件名后按 `browser-tools-settings.ts` 配置落盘。
- **清理、导出与插件边界现状**：
  - `browser-guest-tools.ts:151-176` 与 `BrowserSettingsPanel.tsx:60-85` 已提供按域查看 Cookie 数量、按域删 Cookie 与全量清 `cookies`/`cache`/`storage` 的面板逻辑，但挂在 `browser-tools-hub.ts:61-62` 的 `tab(...)` 分支下。**未查到**在无活跃浏览器标签时从全局设置清理浏览器数据的接口。
  - 导出方面，仅查到 `CHATS_EXPORT_WORK_MARKDOWN`（`src/shared/ipc-channels.ts:70`）用于导出会话 Markdown，**未查到**打包浏览器目录的备份功能；但仍需注意浏览日志、截图（`browser-tools-hub.ts:51, 59`）或页面观察返回本身可能携带敏感 URL 或文本。
  - 插件方面：`src/plugins/api.ts:52-56` 中的 `PluginCapability` 明确注释只是服务可用性声明而非安全权限；插件通过主进程 `require`/`import` 加载（`src/plugins/loader.ts:173-190`、`plugin-runtime.ts:69`），`scripts/verify/storage-boundary.mjs:19, 30, 57` 与 `storage-direct-access.json:17` 仅在构建测试期静态盘点源码中的 `getPath`/`setPath` 调用，并非运行时沙箱。

---

## 二、设计：运行持有（Run Owner）与面板持有（Panel Owner）分开

参考 PR #95（`src/main/memory/sources/main-desktop-session-authority.ts:20-84`）将桌面会话持有拆分为 `kind: "page"` 与 `kind: "run"`（`retainRun` / `releaseRun`）的原则，将 Agent 浏览器的控制持有者拆分为两层：

1. **Panel / Page Owner（界面呈现持有）**：绑定当前主窗口可见聊天页与主框架，负责“当前界面能看哪个网页、向哪个渲染页推状态、当前页面是否有权准入启动”。
2. **Run Owner / `BrowserRunLease`（后台任务执行租约）**：代表“已被有效页面在准入时刻签发的、属于特定运行中 `{ conversationId, runId }` 的浏览器执行权与底层资源租约”。

### 2.1 权限变化声明与核心规则

> **设计定性：** 现有行为及测试用例（`src/main/platform/browser/browser-service.test.ts:450-469`）明确将切会话、隐藏、失焦、遮罩后的所有后台浏览操作（除 `close` 外）判定为拒绝（`permission_denied`）；`electron-browser-service.ts:24` 授权提示也声明“关闭页面、撤销或切换会话后失效”。本设计按负责人决定（见第六节 D1）：**保留精确站点/资源白名单、代理与只读动作范围，同时明确扩大可读查询的执行时机（页面不可见时仅允许只读 `observe` 与不改变页面状态的查询；`click`、`type` 与页面导航挂起待用户切回后再继续）**。授权提示文案必须同步更新，明确说明“切走或隐藏后仅可只读观察，不会在后台代点或输入”。

具体拆分须落实以下契约：

1. **准入签发与不可复活（对齐 #95 `retainRun`）**：
   - 仅当当前激活的 `page` Owner 有效、同源主框架验证通过且用户完成（或该 Run 已在活页下获批）`confirmPermission` 时，才在 Main 侧调用 `retainRun` 签发绑定 `{ conversationId, runId, profile, targetSnapshot, grantSnapshot }` 的 `BrowserRunLease`（对照 `main-desktop-session-authority.ts:72-78`）。
   - **不可复用与防复活**：已撤销或失效的 `page` Owner 绝不可升级为 `run` 租约；同一 `{ conversationId, runId }` 并发发起二次签发时受互斥控制；**Run 一旦进入终态并释放租约后，该 Run 租约不可被任何后续调用复活**；**禁止在后台不可见期间为 `BrowserRunLease` 自动或静默补发新的域名、端口或动作授权**（扩大站点范围必须切回有活页确认）。
2. **完整的业务撤销条件与分层注入**：
   - **不再吊销 lease 的界面事件**：切换聊天会话（A -> B）、Chat 主窗口导航刷新（仅吊销 `page` 类绑定）、窗口最小化/`hide`/`blur`、右侧面板关闭或 React 组件卸载（移除 `ManualBrowserTab.tsx:128-137` 卸载微任务中对活跃 Run 的自动吊销）。
   - **必须立即吊销 lease 的全部业务条件（与 #95 及 D8 对齐）**：
     1. Run 结束、取消或中止（执行器完成 / `run.signal` abort / `releaseRun`）；
     2. 通过组合根注入的判定回调（遵循 `src/main/platform/AGENTS.md:11-14` L1 不可引用高层实现的规则，由 `default-dependencies.ts` 传入 `validateSession`、`isRunActive`）：**会话不再存在、已被删除（`onSessionDeleted`）、模式发生变化不再是原模式、或不再符合受控/允许策略**（对照 `main-desktop-session-authority.ts:43-46`）；
     3. 用户在界面上**显式点击“停止运行 / 撤销浏览器控制 / 关闭后台浏览”**；
     4. 明确发生的授权替换或接管；
     5. **关闭全部聊天主窗口（D8）**或应用进入全局 `shutdown` 阶段。
3. **跨会话与跨事件隔离（贯穿授权、服务与 IPC 出口）**：
   - 拆分必须同步改造 `browser-service.ts:201`（授权域校验）、`257`（`publish` / `onChanged`）、`262`（`usable()`）、`388`（guest 导航与崩溃回调）以及 `default-dependencies.ts:498-501`（发往 `IPC.BROWSER_CHANGED`），使全链路感知所属 `conversationId` 与作用域，**不能直接向单一渲染器无差别广播**；
   - **被动推送与主动查询双隔离**：当主窗口当前显示会话 B 时，Run A 触发的 `onChanged` 敏感 URL、标题或状态事件不得推给 B 呈现为 B 的页面——Main 仅对正处于当前 `page` 展示态的所属会话推送实时页面细节（其他会话如有需要仅展示不含 URL/内容细节的“后台运行任务状态提示”）；会话 B 发起的 `get` / `getPermission` 等主动查询同样不能读到或借用 Run A 的页面对象与授权。

### 2.2 视图脱离、重新挂接、人工接管与资源边界

1. **最小可行落地结构**：
   - 保留现有两套产品入口（窗口工作区标签 `BrowserWorkspaceTabs` + 会话 Agent 浏览视图），**只拆分 Main 侧 `Run` 持有与 `Panel` 展示绑定**，切走会话时复用现有的 `guest.detach()`（`electron-browser-guest.ts:54-57` 仅从父 `contentView` 移除但不调用 `close`/`destroy`）保留底层 `WebContentsView`，不同时引入全新“任务详情内嵌浏览器视口”或隐藏常驻窗口。
2. **后台生命周期、运行时未知项与资源预算（D2、D8）**：
   - 依据 Electron `43.7.0` 资源管理语义，未挂载于窗口的 `WebContentsView` 不会自行关闭其 `webContents`，必须由应用在终止/回收时显式 `destroy()` 否则会泄漏（`electron-browser-guest.ts:102`）。
   - **待核实**：在 Windows 实际运行时，脱离父窗口期间 `WebContentsView` 的页面可见性（`document.visibilityState`）、定时器节流、`executeJavaScriptInIsolatedWorld` 调度以及重新 `addChildView` 后的首帧重绘恢复表现均待真机验证。
   - **关闭全部主窗口与 Run 终态资源回收**：
     - 依 D8 决定，关闭全部 Chat 主窗口时立即中止依赖浏览器的后台 Run 并回收其脱离视图（后续待真机实测可靠后再另案评估托盘态保活）；
     - 依 D2 决定，Run 结束（至少正常结束）后**立即调 `releaseRun` 收回执行租约**，不可再驱动或复活；若需保留页面供用户查看最终结果，**只能转为受限手动查看态**，且必须受 `browserService` 跨会话活页总数上限与闲置超时自动关闭约束。
3. **切回重新挂接与“人工接管”互斥规则（D2）**：
   - 将活体 `WebContentsView` 重新 `addChildView` 挂回右侧面板后，原生 `WebContentsView` 直接接收用户鼠标与键盘事件，因此**并不是“只读观看窗口”**（`electron-browser-guest.ts:101`、`browser-dom-script.ts:63`）。
   - 依 D2-A 决定：切回并重新挂接之后，**用户一旦点击页面或触发手动导航，当前 `observation` 立即作废，浏览器执行权立即让出给人工，暂停后续 Agent 浏览器操作；直到用户显式点击“恢复代理”才重新允许 Agent 继续执行**（恢复前旧观察继续保持无效，需重新 `observe`）。

### 2.3 `executeAgent` 门禁区分与状态一致性改造

1. **按操作类型区分不可见门禁（D1-B）**：
   - **只读操作（`observe` 与不改变页面状态的查询）**：只要 `leaseCurrent(lease)`、`usable(cell)`（不要求 `attached` / `focused`）与域名策略有效，在切会话、窗口隐藏或失焦的脱离状态下**允许继续执行**；
   - **改变状态/交互操作（`click`、`type`、`navigate`、`open`、`back`、`forward`、`reload`）**：**必须同时满足页面处于当前展示并受控状态（未脱离、非人工接管暂停中）**；在页面不可见期间，此类操作**先挂起**（向等待的 Run / 渲染层状态条提示“等待切回会话以继续操作”并等待用户切回挂接，直至切回继续或超时/`abort` 取消），**禁止在不可见状态下执行点击、输入或页面跳转**。
   - **`close`**：保持任何合法撤销/结束路径下可执行清理。
2. **`observation` 一致性校验**：
   - 完整保留现有的 `requestId`、当前 `URL`、同一 `document` 引用（`browser-dom-script.ts:55, 62`）、单次 `observation` 消费以及服务端有效 `ref` 校验（`browser-service.ts:572-588`）。
   - 不采用“只要 URL 未主框架跳转即可安全点击”的弱断言：**主框架导航、加载失败、人工点击/导航接管与显著视口尺寸变更（如脱离态尺寸与重新挂接面板尺寸不一致）均须直接作废 `observation`**；UI 上 `ManualBrowserTab.tsx:128-137` 的被动 unmount 不再发出撤销活跃 Run 权限的微任务，仅保留用户显式点击取消/停止入口。

### 2.4 涉及修改的模块/接口（PR A 范围）

| 模块 / 文件 | 拟改内容 | 边界说明 |
|---|---|---|
| `src/main/platform/browser/browser-host-owner.ts` | 为 `registerBrowserHostOwner` 拆分出面向界面展示的 `Page` 证明与 `retainRunLease` / 组合根策略检查接口；刷新/切会话只使旧 `Page` 证明失效，不自动中止 `Run` 租约；关全部主窗触发中止回调。 | 严格通过注入回调验证会话/模式/受控性，不违反 L1 分层。 |
| `src/main/platform/browser/browser-service.ts` | 区分展示绑定与 `BrowserRunLease`；统一更新 `usable()`、`onChanged` 推送路由、`executeAgent` 的 D1-B 只读放行与写操作/导航挂起门禁、D2 人工接管状态与 `observation` 失效源、以及活页总量上限与闲置超时回收。 | 保持独立临时 `Session`、域名白名单、`isAccountPath` 与 `agentBusy` 不变。 |
| `src/main/agent/tools/browser-workspace-executor.ts` & `src/main/app/default-dependencies.ts` | Run 准入后持有 `BrowserRunLease`，结束即调 `releaseRun`；组合根注入 `onChanged` 的目标归属过滤、会话/运行校验回调与主窗全关中止信号。 | 保障被动事件与主动查询双重跨会话隔离。 |
| `src/renderer/react/features/chat/workspace/ManualBrowserTab.tsx`（及展示容器） | 区分组件被动 unmount 与用户显式停止/撤销操作；切回挂接时接回活体视图；展示挂起提示与“恢复代理”操作入口（人工点击/导航后让出控制权）。 | 窗口工作区 `workspaceId` 标签保持原有跨会话独立行为。 |

---

## 三、设计：登录状态本地保存

> 依据负责人决定（D3、D4、D5、D6、D7）：代理浏览继续保持独立临时 `Session`；持久保存**仅面向用户手动公网网页浏览**，且与双清除入口、`cookieEncryption` 加密启用及无痕标签在同一 PR（PR B）中完整交付。

### 3.1 持久化机制、目录与共享 `Session` 生命周期矩阵

1. **Partition 命名、存储目录与隔离边界（D4、D7）**：
   - 使用 Electron 原生持久分区（`node_modules/electron/electron.d.ts:12477-12480`）：全局单档案命名为 **`persist:firefly-manual-default`**，接口层预留 `profileKey` 参数以便后续扩展多档案。普通持久工作区移除 `{ cache: false }` 以恢复正常 HTTP 缓存行为。
   - **默认启用前置条件（D4 + D7）**：仅当打包配置启用 `cookieEncryption` fuse 且运行期加密密钥可用时，手动公网浏览才默认启用 `persist:firefly-manual-default`；若密钥不可用（或未具备加密能力），**严禁写入持久化分区，必须明确提示用户并退回临时无痕内存 `Session`**。
   - Electron `43.7.0` 底层会对 partition 名规范化并落到 `sessionData/Partitions/<id>` 下。结合 `runtime-profile.ts:54-57, 70-71, 96` 与 `storage-context.ts:40`：
     - **生产环境**：位于 `%APPDATA%\Firefly-1.2.0\Partitions\firefly-manual-default`（以 `getStoragePath()` 实测为准）；
     - **非生产隔离环境**：`development` 位于 `<isolationRoot>/Firefly-development/session/Partitions/...`（`test`/`smoke` 为对应 `Firefly-<kind>/session/Partitions/...`）。
   - 浏览器子系统必须直接沿用组合根传入的 `StorageContext.sessionRoot` 与 `session.fromPartition(...).getStoragePath()` 开展管理与校验，不在 `browser/` 新增 `app.getPath` 调用；同时注意 `scripts/verify/storage-boundary.mjs:19, 30, 57` 只盘点源码显式路径调用，实际隔离目录写入须在 PR B 集成测试中验证 `getStoragePath()` 严格位于 `sessionRoot` 下。
2. **共享 `Session` 的四项基础设施改造**：
   - **档案（Profile）级网络枢纽与代理管理**：当前 `browser-domain-proxy.ts:13, 36` 与 `authenticated-connect-proxy.ts:69, 190` 将代理与凭据绑定在单 `webContentsId` 与单域 `signal` 上；共享后按持久化档案（以及各无痕内存档案）维护单一代理实例与 `webContentsId -> Domain` 路由表，将 `authenticated-connect-proxy` 与 `app.on("login")` 凭据提升至档案作用域管理，避免单标签覆写 `session.setProxy(...)`。
   - **特例与无痕/内网严格分流**：由于 Chromium 中 `session.setProxy()` 作用于整份 `Session`，**本机/局域网调试（direct 直连）、非 `web: true` 的单域白名单标签、临时聊天专属视图与手动“无痕标签页”均继续使用各自独立的临时内存 `Session`**，绝不与 `persist:firefly-manual-default` 共用 `Session`。
   - **下载按来源页分发**：依据 Electron `43.7.0` `will-download(event, item, webContents, frame)`（`node_modules/electron/electron.d.ts:13032-13038`），通过 `webContents.id` 路由到对应标签所属的工作区策略；缺失归属或非允许模式一律拒绝。
   - **无 `webContentsId` 请求与 Service Worker（SW）边界**：现有 `browser-authorization-domain.test.ts:74-77` 验证了缺失 `webContentsId` 时继承 `Session` 策略；在共享持久 `Session` 下，必须为无 `webContentsId` 的 SW 后台请求设定明确归属与策略检查，并在“清除档案/站点数据”时主动停止相关运行中 Service Worker 防止重建写回。
3. **共享 `Session` 生命周期行为矩阵**：

| 生命周期事件 | 视图 (`WebContentsView`) | 路由表与授权域 | 代理与 `closeAllConnections()` | 持久化存储与 Service Worker |
|---|---|---|---|---|
| **1. 关闭单个标签**（仍有其他标签共享同档案） | 销毁该标签自己的 `WebContentsView` 并清理其注册条目。 | 从档案路由表注销该 `webContentsId`；仅销毁该标签域状态。 | **不关闭共享代理，严禁调用 `session.closeAllConnections()`**（否则切断同档案其他标签连接）。 | **禁止**调用 `clearStorageData`/`clearCache`；**不等待**全局 `runningWorkerCount() === 0`。 |
| **2. 关闭最后一个活跃标签** | 销毁最后一个标签的视图。 | 路由表清空。 | 可停止按需代理或延迟超时回收；此时不再影响其他活页。 | **保留**磁盘 Cookie/存储；待核实是否需要 `cookies.flushStore()` 促发写盘及空闲 SW 收敛。 |
| **3. 用户清除站点或重置档案** | 先暂停/关闭正在显示受影响站点的活跃标签页。 | 注销受影响域；清理失败保留失败态。 | 中止相关传输并阻断活页写回。 | 先停止运行中 Service Worker 再执行 Cookie / Storage / Cache 清除；回查验证清理结果。 |
| **4. 应用正常退出（`shutdown`）** | 销毁全部活体 `WebContentsView`。 | 全量 `revokeAll` 注销。 | 关闭档案级 CONNECT 代理，调用 `closeAllConnections()`。 | **不执行 `clearStorageData`**；调 `cookies.flushStore()` 并停止全部运行中 SW 后退出。 |

### 3.2 隔离规则：代理浏览、临时聊天与无痕标签页（D3、D4、D5）

1. **工作区默认共享粒度（D4）**：普通公网手动浏览在满足 D7 加密前提下默认使用全局单档案 `persist:firefly-manual-default`（保留 `profileKey` 参数以备未来扩展）。
2. **代理浏览严格隔离（D3）**：**`mode: "agent"` 一律使用独立的无 `persist:` 临时内存 `Session`，绝不复用用户手动浏览的持久化登录态**。此举旨在隔离对手动登录凭据（邮箱、网盘、代码库等会话 Cookie）的自动复用（同时明确：匿名代理浏览器自身仍存在页面正文间接提示词注入、GET 副作用等风险，不因此放宽现有站点白名单与只读 DOM 限制）。
3. **临时聊天与显式无痕标签页（D5）**：
   - **临时聊天约束范围**：`temporary: true` 会话（`chats-store.ts:187`）**只约束从该临时聊天会话流自身打开的专属浏览视图**强制使用一次性无 `persist:` 内存分区；窗口级多标签工作区（`conversationId: null`，`browser-host-owner.ts:60`、`BrowserWorkspaceTabs.tsx:125`）继续保持跨会话独立，不随着切到临时聊天而重置或切换底层档案（界面明确提示窗口公共浏览器与临时聊天的独立边界）。
   - **手动“无痕标签页”**：在窗口工作区中新增由用户主动点击新建的**“无痕标签页”**（独立无 `persist:` 临时内存 `Session`，与持久档案标签物理隔离，关闭标签或应用即销毁全量存储）。
   - **权威判定归 Main**：是否进入无痕分区、当前是否处于临时会话上下文，**一律由 Main 依据其保存的权威会话记录与标签创建命令判定，严禁采信渲染层传递或上报的 `temporary` 字段**。

### 3.3 双清除入口、防回写闭环与退出/重启语义（D6）

1. **两处清理入口与主设置对接（D6）**：
   - **入口 1 — 浏览器内设置面板（`BrowserSettingsPanel.tsx`）**：升级现有 Cookie 查看与清理（`browser-guest-tools.ts:151-176`），面向整份受管持久档案与无痕标签隔离管理。
   - **入口 2 — 主应用“隐私与数据”设置分类**：在设置窗体（`src/renderer/settings/` 与 `src/main/features/settings/`）新增独立“隐私与数据”设置页面及对应主进程服务/IPC（直接操作受管 `session.fromPartition("persist:firefly-manual-default")`，**不依赖任何打开中的浏览器标签**即可按域查看、按源清除或全部清空浏览器登录态与缓存）。
2. **清除前停页与停 SW 防写回闭环（D6）**：
   - 解决现状中 `browser-guest-tools.ts:161-175`“仅清 Cookie 不精清同站点 storage、且活页/SW 可回写”的缺陷：
     1. 执行清除（按站点源 `origin` 精确清理、全清或档案重置）时，**Main 先暂停/关闭正在显示受影响站点的活跃标签页，并停止关联运行中 Service Worker**，杜绝旧页面与 SW 在清理前后将内存令牌写回磁盘；
     2. 再执行 `cookies.remove` / `clearStorageData` / `clearCache` / `clearAuthCache`；
     3. 执行清理后校验确认（例如复查 `cookies.get` 等），**若任一步失败必须保留明确的失败状态供 UI 展示与重试，严禁伪装成功**；清理完毕后再恢复可用页面状态（或提示刷新重新登录）。
3. **退出登录与跨重启恢复边界**：
   - 网页内退出登录由站点自身流程决定（可能同时涉及 IndexedDB 与服务端撤销），“删某域 Cookie”不能作为所有网站登出的唯一兜底保证。
   - 依据 Electron `43.7.0` 文档（`node_modules/electron/electron.d.ts:7345-7355`），Cookie 写入默认每 30 秒或 512 次操作刷盘一次，应用退出流程须显式调用 `cookies.flushStore()` 促使立即写盘（强杀/断电下的崩溃耐久性仍标为**待核实**）。
   - 跨重启保留的是允许持久化的磁盘浏览器存储，不承诺所有网站永久免登录（短 TTL Cookie 或风控仍会要求重登），也不负责恢复标签栏列表、DOM 滚动位置或纯内存的 `sessionStorage`。

### 3.4 安全性与加密边界如实说明（D7）

1. **`cookieEncryption` fuse 与平台加密实情（Electron `43.7.0`）**：
   - **打包启用决定（D7）**：PR B 在构建打包配置中**正式启用 `cookieEncryption` fuse**（当前默认依赖 `node_modules/electron/dist/electron.exe` 中 `EnableCookieEncryption` 实测为 `'0'`/`48` 关闭，且 `electron-builder.yml:15` 指向该目录，因此打包阶段须集成启用 fuse 与产物校验脚本；**打包后发布物 fuse 位校验在构建流水线中列为必查验收项**）。
   - **密钥不可用降级契约（D7）**：若运行时遇到 OS 密钥提供器不可用等无法保证 Cookie 加密写入的情况，**禁止静默降级为明文落盘，必须拒绝写入持久分区、向用户弹出明确告警提示并退回无痕内存 `Session`**。
   - **必须如实交代的三点客观限制（D7 明确要求）**：
     1. **启用后不可随意关回**：Electron 官方明确说明 `cookieEncryption` fuse 启用并生成加密 Cookie 存储后，若在后续版本改回关闭，已有加密 Cookie store 将不可用；
     2. **Windows DPAPI 不防范同账户进程**：在 Windows 上，DPAPI 以当前操作系统登录用户作为加密边界，防的是脱离当前 OS 账号的离线磁盘拷贝窃取，**不防范以同一 OS 用户名运行在本机上的其他进程读取或请求 OS 解密**；
     3. **`localStorage` / `IndexedDB` 没有同等级加密**：Chromium 磁盘上的 `localStorage`、`sessionStorage`、`IndexedDB`、HTTP Cache 与 Service Worker 数据仍按标准磁盘格式保存，未享受与 Cookie 同等的密钥加密保护，因此本地持久化不代表全量登录令牌均处于高强度加密下。
2. **主进程插件与导出边界现状**：
   - 宿主 API（`src/plugins/api.ts:52-56`）虽不暴露浏览器 `Session` 或 Cookie 接口，但本地主进程插件通过 `require`/`import` 运行在主进程中（`src/plugins/loader.ts:173-190`、`plugin-runtime.ts:69`），`scripts/verify/storage-boundary.mjs` 亦非运行时沙箱。因此可信主进程插件仍处于完全信任边界，开启本地登录态保存后主进程地址空间与用户目录内的敏感凭据暴露面客观增大。
   - 导出与日志遵循白名单原则：任何未来的设置/诊断包导出都严禁包含 `Partitions/` 目录，同时审查日志、页面截图（`browser-tools-hub.ts:51, 59`）、URL 与 `observe` 文本防止凭据间接外泄。

---

## 四、相关问题

### 4.1 左侧分隔线拖拽异常调查结论（只记录，不排入近期修复）

通过源码比对**工作正常的右栏内部分隔线**与**存在故障的左侧聊天/右栏分隔线**，当前形成以下**有源码依据支撑的原因假设**（具体事件截断与定位同步链仍须后续真机实测核实）：

1. **源码依据一：外层 `ff-dock-separator` 拖拽期未联动 `data-shielded` 隐藏原生视图**：
   - 内部正常路径：`RightInspector.tsx:215-239, 255` 在内部分隔线 `startResize`/`startRowResize` 时设 `resizing=true`，给 `<aside className="ff-right-inspector">` 挂载 `data-shielded`；`RightInspector.css:62` 通过 CSS 将已加载网页视口设为 `display: none`；`ManualBrowserTab.tsx:295-309` 的 `ResizeObserver` 观测到 0×0 后发出 `layout({ bounds: null })`，`browser-service.ts:442, 447` 执行 `detach(cell)` 移走叠放于最顶层的 OS 原生 `WebContentsView`。
   - 故障外层路径：`ChatPage.tsx:1306-1316, 1530-1540` 使用 `react-resizable-panels`（本地版本 `4.12.4`，见 `node_modules/react-resizable-panels/package.json:3`），`ChatPageInspector.tsx:35-49` 仅在开关面板 `visible` 动画期间设置 `moving=true`，**在左右拖动 `ff-dock-separator` 期间既未置 `data-shielded`，也未将原生 `WebContentsView`（`electron-browser-guest.ts:101` `addChildView`）暂时脱离主窗口**。
2. **源码依据二：`react-resizable-panels` 仅在 `pointermove` 后才调用 `setPointerCapture`**：
   - 检查 `node_modules/react-resizable-panels/dist/react-resizable-panels.js:1179-1201, 1297-1301, 1518`：库将 `pointerdown` / `pointermove` / `pointerup` 监听在 `ownerDocument` 上；`pointerdown` 处理函数 `je`（`L1179`）仅把状态置为 `"active"`，**并不捕获指针**；直到在 `"active"` 态收到随后的 `pointermove`（`L1297-1301`）时，才对命中分隔元素调用 `setPointerCapture(e.pointerId)`。
   - 叠加上 `ChatPage.tsx:1315` 配置了 `resizeTargetMinimumSize={{ coarse: 33, fine: 24 }}` 外溢命中区（边缘紧贴甚至侵入右侧面板方向），一旦指针在按住或向右滑动过程中越过原生 `WebContentsView` 边界，主窗口文档预期会丢失后续指针控制流。
3. **须真机确认的待核实事件链**：
   - **待核实 1**：在 Electron 43.7.0 / Windows 下，鼠标跨越 `WebContentsView` 边界时具体哪些 `pointermove` / `pointerup` / `pointerleave` 事件被 OS 子视图截断，以及 `setPointerCapture` 在跨视图前是否实际生效又丢失；
   - **待核实 2**：拖拽过程中纯左移或纯位置平移时，`ManualBrowserTab.tsx:302` 的 `ResizeObserver` 是否存在漏报位置偏移（`x`/`left` 改变而宽高未变）导致松手后原生视图 `bounds` 残留在旧坐标的现象，以及 `CSS -> ResizeObserver -> IPC -> setBounds` 异步管线叠加造成的脱节。
4. **后续实施要点**：参照右栏 `RightInspector` 的现有屏蔽机制进行修复，但须覆盖包含 `resizeTargetMinimumSize` 扩展命中区在内的实际拖动手势生命周期（勿仅依赖 `<Separator>` 节点上的 React `onPointerDown`），严密处理 `pointerup`、`pointercancel`、`blur`、组件卸载及拖动结束后的最终 `bounds` 重测校准。按负责人排期，**本问题留待仓库布局整体调整完成后的 PR C 解决**。

### 4.2 调研发现的其他关联线索

1. **`useSidebarWidth` 最左侧导航分隔线同样未屏蔽右侧原生视图**：`ChatPageNavigation.tsx:154-158` 的 `ff-sidebar-resizer` 在拖动期间未联动 `data-shielded`；且 `ChatPage.tsx:1533` 注释已反映 `react-resizable-panels` v4 与 sidebar 取消拖拽之间的 `ownerDocument` 指针状态互相影响，在 PR C 中一并核查。
2. **`blur`/`hide` 阻塞与前端自动撤销耦合**：当前架构下哪怕不切换会话，仅仅窗口失焦也会令 `executeAgent` 因 `hostVisible` 失败（`browser-service.ts:555, 606`）；且非工作区面板卸载时会自动通过微任务吊销授权（`ManualBrowserTab.tsx:131-136`），均归入 PR A 改造范围。

---

## 五、分步实施顺序（与施工计划一致）

按定稿设计及项目布局排期，拆分为以下 **3 个顺序 PR** 实施（详见施工计划 `docs/superpowers/plans/browser-owner-and-session.md`）：

1. **PR A：运行持有与面板展示分离（D1-B、D2、D3、D8），保持原有独立临时 `Session`**
   - 拆分 `Page` 证明与 `BrowserRunLease`（`retainRun` / `releaseRun` 语义、业务撤销全覆盖与防复活）；
   - 实现 D1-B（不可见期仅放行只读 `observe` 与非状态查询，挂起点击/输入/导航直至切回）、D2-A（重新挂接后人工操作立即作废 `observation` 并让出执行权，点击“恢复代理”才继续；Run 结束收回租约，预览页面转手动查看态且受总量/超时回收）、D3（Agent 独立临时 `Session`）、D8（关全部聊天窗口中止后台浏览器 Run）及跨会话主被动事件/查询隔离。
2. **PR B：手动浏览的持久档案、双清除入口、加密与无痕标签（D4、D6、D7、D5）**
   - 重构共享 `persist:firefly-manual-default` 网络枢纽（档案级代理/凭据、`webContentsId`/SW 路由、单标签关闭不断链/不清存储、预留 `profileKey`）；
   - 同批交付 **D6 双清除入口**（主设置“隐私与数据” + 浏览器设置，执行前停活页与停 SW 防写回并校验清理结果）、**D7 `cookieEncryption` fuse 打包启用与密钥不可用退回无痕告警**、**D5 临时聊天专属视图约束 + 手动工作区“无痕标签页”**。
3. **PR C：仓库布局整体调整完成后修复左侧分隔线**
   - 在整体布局重构落地并真机核实 `ff-dock-separator` / `ff-sidebar-resizer` 事件链后，参照右侧分隔线现有屏蔽方式完成修复与端到端拖拽验收。

---

## 六、负责人决定

以下全部设计分歧与产品边界已由负责人最终拍板确认（含对应理由与留作后续演进的背景选项）：

| 编号 | 决策主题 | 已定结论（决定） | 理由 | 留给以后的选项（本期不做） |
|---|---|---|---|---|
| **D1** | **不可见期间 Agent 浏览器动作许可** | **先上 B：** 页面不可见时仅允许只读 `observe` 与不改变页面状态的查询；`click`、`type` 与页面导航/跳转先挂起，等用户切回后再继续。 | 既消除切会话/失焦导致的任务误断链与上下文丢失，又防止用户在不可见状态下对网页盲目点击/输入造成难以觉察的副作用，同步控制安全范围变更幅度。 | **C（后台连续执行全部动作）：** 允许在后台继续 `navigate`/`click`/`type`，配套显著“后台浏览中”徽标、授权说明更新与一键停止入口——作为以后独立立项的目标态，本期不做。 |
| **D2** | **切回人工接管规则与 Run 终态资源回收** | **选 A：** 切回并重新挂接后，用户一点击或手动导航，当前 `observation` 立即作废并把控制权让给人工，直到用户点击“恢复代理”才继续；Run 结束（至少正常结束）后立即收回执行租约，不可再驱动或复活；若需留页供查看结果，只能转手动查看态并设后台活页总数上限与闲置超时。 | 防止重新挂接后用户手动操作与 Agent 并发踩踏 DOM 导致误点击；防止已完成 Run 凭租约在后台继续驱动或耗尽 `WebContentsView` 原生进程内存。 | **备选 B：** 人工操作直接强制中止该步并注入提示让模型重规划，或根据不同任务类型配置不同的终态保留策略。 |
| **D3** | **代理浏览（`mode: "agent"`）是否复用手动登录态** | **选 A：** `mode: "agent"` 一律继续使用独立无 `persist:` 的临时内存 `Session`，绝不复用手动浏览保存的登录态。 | 有效隔离间接提示词注入场景下对用户手动登录凭据（个人邮箱、网盘、业务后台 Cookie）的自动复用，与匿名公网安全基线保持一致。 | 如后续有强烈需求，可作为独立特权能力立项，单独设计站内动作粒度、凭据选择与审计模型。 |
| **D4** | **手动浏览本地持久化的启用条件与隔离粒度** | 采用**全局单档案**（`persist:firefly-manual-default`），架构与接口预留 `profileKey`；**仅在 D7 加密启用且密钥可用时默认开启持久化**，否则不默认开启持久落盘。 | 全局单档案最符合桌面用户的日常浏览器习惯（切会话/重启无需重复登录常用工具站），预留 `profileKey` 保留扩展能力；把默认开启绑在加密前提上保证默认安全基线。 | 按绑定的 `workspaceRoot` 自动分档，或显式的多账号 Profile 切换器，后续基于 `profileKey` 扩展。 |
| **D5** | **临时聊天（`temporary: true`）与窗口独立工作区边界** | **选 A + B：** 临时聊天只约束从它自己会话内部打开的专属浏览视图强制使用无痕内存分区；窗口级多标签工作区本身保持会话无关，不跟着临时聊天切换。另外在工作区增加由用户主动新建的**“无痕标签页”**。是否无痕**一律由 Main 判定**，绝不信渲染层上报的 `temporary`。 | 不破坏窗口多标签工作区原本跨会话独立的架构定位，也不让渲染层掌握持久化/无痕的切换裁决权，同时给需要绝对隐私的用户提供明确的显式无痕入口。 | 若未来改变多标签归属模型，可再扩展按会话分组的标签空间。 |
| **D6** | **清除数据入口位置与防写回契约** | 清除入口放**两处**：主设置窗口“隐私与数据”分类，以及浏览器内 `BrowserSettingsPanel`；执行清除前**先停掉正在显示受影响站点的活跃标签页和运行中 Service Worker** 再清除，防止内存回写；与 D4 持久化、D7 加密和 D5 无痕标签在**同一 PR（PR B）**中交付。 | 确保未开启浏览器面板时也能管理与彻底删除个人数据，补全单站清除对活页/SW 写回的漏洞，守住“不能先上线无法安全彻底清理的持久存储”的隐私底线。 | 按站点精确隔离存储目录及更细粒度的自动定期清理周期策略可后续增强。 |
| **D7** | **Cookie 加密 fuse（`cookieEncryption`）策略与边界披露** | **选 A：** 打包时启用 `cookieEncryption` fuse；若运行期加密密钥不可用，拒绝写入持久区、明确向用户报错提示并退回无痕内存 `Session`。设计文档明确写实三点限制：启用后不可随意关回；Windows DPAPI 不防同 OS 用户下其他进程；`localStorage`/`IndexedDB` 无同等级加密。 | Electron 43.7.0 默认关闭该 fuse 导致 Cookie 明文落盘，启用构建 fuse 是桌面应用防止离线直读 Cookie 数据库的必要基线，同时必须诚实告知真实防御边界与回退代价。 | 在不涉及既有用户数据时提前评估企业级自定义密钥库/系统级增强封装（如需跨组件扩展存储加密）。 |
| **D8** | **关闭全部 Chat 主窗口缩入托盘时后台 Run 的去留** | **选 B：** 在完成 Windows 真机实测验证之前，用户关闭全部聊天主窗口时直接停止依赖浏览器的后台 Run。 | 避免在未实测无任何父 `BrowserWindow` 时 Chromium 节流、渲染挂起或脱离泄漏的真实行为前，对用户做出无保障的后台保活承诺。 | 将来在 Windows 真机完成脱离/隐藏窗口保活及资源节流实测可靠后，再评估**限制型 A**（仅限特定窗口隐藏保活，配严格并发与超时回收）。 |
