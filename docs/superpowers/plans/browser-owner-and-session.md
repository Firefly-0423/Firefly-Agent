# 浏览器持有者拆分、本地登录态持久化与分隔线修复施工计划

状态：已定稿（待按 PR 分步施工）
日期：2026-11-17
设计依据：[docs/design/browser-owner-and-session.md](../../design/browser-owner-and-session.md)
基线：`dev/firefly-1.2.0` / `633eb36986c772a30aa24cc64ec2c853549d58d6`

**目标：** 将 Agent 浏览器控制权从“页面呈现生命周期”中拆分出来，避免切会话、刷新或失焦打断后台运行，同时限定不可见态只读并支持切回人工接管；为手动公网浏览增加受 `cookieEncryption` 与双入口清理保护的持久化登录态及显式无痕隔离；并在仓库布局调整完成后修复左侧分隔线拖拽异常。
**架构：** 在主进程拆分 `Page` 展示证明与受策略约束的 `BrowserRunLease`（D1-B、D2-A、D3、D8），保持 Agent 独立临时匿名 `Session` 与跨会话事件/查询隔离；在手动公网工作区升级为档案级（`persist:firefly-manual-default`）共享网络路由与代理管理，并同批落地 `cookieEncryption` fuse、双清除入口与防回写闭环（D4、D5、D6、D7）；最终在布局调整后对照右栏方案补齐外层分隔线拖拽屏蔽。
**保持不变：** 现有域名/资源精确白名单、CONNECT 代理与 DNS 出口校验、只读 DOM 隔离脚本（`SENSITIVE_FIELD_SOURCE` / `isAccountPath`）、`agentBusy` 互斥锁、工作区多标签跨会话独立体验、`StorageContext.sessionRoot` 边界以及 `src/main/platform/AGENTS.md` L1 分层约束（组合根注入上层会话校验）。

## 全局约束

- 每个 PR 按施工包拆分提交，每个提交单独通过测试；文档最后提交。
- 严格遵守 `src/main/platform/AGENTS.md`：L1 `src/main/platform/browser/` 禁止直接引用会话或运行循环高层模块，所需会话存在性、模式与运行态判定由组合根 `src/main/app/default-dependencies.ts` 注入。
- 严格遵守存储边界：复用 `StorageContext.sessionRoot` 与 `session.fromPartition(...).getStoragePath()`，不在浏览器模块新增 `app.getPath` / `setPath` 调用；任何施工包不得破坏 `npm run check:storage-boundary`。
- 不在设计未包含范围擅自引入后台 `click`/`type`/`navigate`（D1-C 为后期目标态）或托盘无窗口保活（D8）。
- 严禁单独交付“无可靠清除入口或未启用加密门控”的持久化磁盘登录态功能。

---

## PR A：运行持有与面板展示分离（D1-B、D2、D3、D8，保持独立临时 Session）

### 施工包

- [ ] **包 A1 — `Page` 证明与 `BrowserRunLease`（`retainRun` / `releaseRun`）授权拆分**：有效 `page` Owner 准入后在 Main 签发不可复活、互斥受控的 `BrowserRunLease`，通过注入回调校验会话存在、未删除、原模式、允许策略与显式停止/接管，并在全部主窗关闭（D8）或应用退出时收回。
- [ ] **包 A2 — `BrowserService` 后台脱离、D1-B 动作门禁与跨会话事件隔离**：切走会话/失焦/隐藏时仅 `detach` 保留活体 `WebContentsView`（设跨会话活页上限与闲置超时回收），放行后台只读 `observe` 与非状态查询，**挂起**不可见期间的 `click`/`type`/页面导航等待切回；保持 `mode: "agent"` 独立临时 `Session`（D3）；`publish`/`onChanged` 与 `get` 查询按所属 `conversationId` 双重隔离，不向无关会话页推送后台敏感 URL/状态。
- [ ] **包 A3 — 前端面板挂载、人工接管（D2-A）与 Run 终态回收联动**：移除 `ManualBrowserTab` 被动 unmount 自动调 `revokePermission` 的副作用；切回原会话时重新 `attach` 活体视图，一旦用户点击或手动导航即刻作废 `observation` 并暂停让权给人工，需用户显式点击“恢复代理”才继续；Run 正常/异常结束立即收回租约，仅在需要查看结果时按上限转为只读/手动查看态。

### 涉及的文件

- `src/main/platform/browser/browser-host-owner.ts`
- `src/main/platform/browser/browser-service.ts`
- `src/main/platform/browser/electron-browser-service.ts`（同步更新后台只读约束授权提示文案）
- `src/main/platform/browser/electron-browser-guest.ts`
- `src/main/agent/tools/browser-workspace-executor.ts`
- `src/main/app/default-dependencies.ts`
- `src/renderer/react/features/chat/workspace/ManualBrowserTab.tsx`、`src/renderer/react/features/chat/workspace/BrowserWorkspaceTabs.tsx`
- 既有及新增单测/集成测试：`browser-host-owner.test.ts`、`browser-service.test.ts`、`electron-browser-agent-integration.test.ts`、`ManualBrowserTab` 相关前端测试

### 测试要点（外部可观察行为）

- **权限与准入/防复活**：未通过有效 `page` 准入不可签发 `BrowserRunLease`；Run 结束或撤销后同一 `runId` / lease 不可复活；后台期间申请新增域名/动作授权被拒绝。
- **D1-B 后台只读与挂起**：切走会话（A -> B）、主窗 `blur`/`hide` 后，会话 A 的 `observe` 与只读查询继续成功；`click`/`type`/`navigate`/`back`/`forward`/`reload` 在不可见期间保持挂起且不修改页面，切回 A 挂接后继续完成（或被显式取消/超时中止返回 `cancelled`）。
- **D2-A 人工接管与终态清理**：切回挂接后用户手动点击或地址栏导航，界面切换为人工接管暂停态且旧 `observation` 立刻失效（Agent 试图按旧 `snapshotId` 点击被拒绝），点击“恢复代理”并重新 `observe` 后恢复执行；Run 结束后租约立即可观查释放，超过活页上限或闲置超时自动销毁释放内存。
- **D8 关窗与取消/失败路径**：关闭全部聊天主窗口立即中止运行中浏览器 Run 并触发清理；删除会话、主动点停止或触发中止信号时正确清理全部 `WebContentsView` 并向调用方返回取消失败；`executeAgent` 遇到未预期脱离/失效返回规范错误码而非悬死。
- **跨会话隔离**：后台 Run A 发生页面导航或状态变化时，正在显示会话 B 的界面收不到 Run A 的页面 URL/标题广播，会话 B 主动查询也无法读出或操作 Run A 视图。

### 验证命令

- `npm test`
- `npx tsc -p tsconfig.main.json --noEmit`
- `npx tsc -p tsconfig.preload.json --noEmit`
- `npx tsc -p tsconfig.renderer.json --noEmit`
- `npm run build`

---

## PR B：手动浏览持久档案、双清除入口、加密与无痕标签（D4、D5、D6、D7）

### 施工包

- [ ] **包 B1 — 共享 `Session` 档案级网络路由与生命周期枢纽**：重构网络绑定与授权域，按持久档案维护共同 CONNECT 代理、`app.on("login")` 凭据与 `webContentsId` 请求/`will-download` 分发；明确无 `webContentsId` 的 worker / SW 请求规则；实现单标签关闭不断开同档案连接与不清理存储、最后标签关闭留存磁盘与退出 `flushStore()`；本机/内网与非 `web: true` 单域维持独立临时 `Session`。
- [ ] **包 B2 — `persist:firefly-manual-default` 档案开关、`cookieEncryption` fuse 与降级提示（D4、D7）**：接入持久化分区（预留 `profileKey` 扩展字段）；打包与构造流水线启用 Electron `cookieEncryption` fuse；运行时检测系统密钥/加密前提，若不可用则拒绝写入持久区、向用户弹出明确提示并退回无痕内存 `Session`。
- [ ] **包 B3 — 临时聊天专属约束与手动“无痕标签页”（D5）**：主进程基于权威 `chats-store` 记录约束 `temporary: true` 会话内打开的专属浏览视图为无痕内存分区（绝不采信渲染层 `temporary` 上报）；窗口工作区保持会话无关并新增由用户主动新建的“无痕标签页”及明显隔离标识。
- [ ] **包 B4 — 双清除入口与防回写闭环（D6）**：升级浏览器内 `BrowserSettingsPanel` 清理流程，并在 `src/renderer/settings/` 与 `src/main/features/settings/` 新增主设置“隐私与数据”分类及全局清理服务（不依赖打开中浏览器标签即可列出域与按源/全档案清除）；清理前先暂停/关闭受影响活页并停止运行中 Service Worker 防回写，清理后执行结果核验并保留异常失败状态；补充设计/隐私文档中对加密三点客观限制的用户提示文案。

### 涉及的文件

- `src/main/platform/browser/browser-network-binding.ts`、`src/main/platform/browser/browser-authorization-domain.ts`
- `src/main/platform/browser/browser-domain-proxy.ts`、`src/main/platform/browser/authenticated-connect-proxy.ts`
- `src/main/platform/browser/electron-browser-service.ts`、`src/main/platform/browser/manual-browser-workspace.ts`
- `src/main/platform/browser/browser-tools-hub.ts`、`src/main/platform/browser/browser-guest-tools.ts`
- `src/main/features/sessions/chats-store.ts`（或会话作用域权威判定消费接线）、`src/main/app/default-dependencies.ts`
- `src/preload/browser.ts`、`src/shared/manual-browser.ts`、`src/shared/browser-tools.ts`、`src/shared/ipc-channels.ts`
- `src/renderer/react/features/chat/workspace/BrowserWorkspaceTabs.tsx`、`src/renderer/react/features/chat/workspace/BrowserSettingsPanel.tsx`
- 主应用设置“隐私与数据”新增面板与 IPC 接线：`src/renderer/settings/` 下（`index.html`、`shared/section-router.ts`、`i18n/` 及新增隐私数据模块）与 `src/main/features/settings/` 下（`settings-ipc.ts` 等）
- 构建与验证脚本：`electron-builder.yml`、`package.json`（及打包 fuse 启用/校验脚本）
- 对应单测、隔离存储边界测试与清理/打包集成测试

### 测试要点（外部可观察行为，含必填项）

- **Cookie 跨重启保存**：开启加密门控下的手动公网工作区登录设置 Cookie 与站点存储，关闭并重启服务/应用实例后，Cookie 与受支持站点状态保持可读，且目录严格位于 `StorageContext.sessionRoot/Partitions/firefly-manual-default`（开发/测试环境不污染生产目录）。
- **清除后页面不会写回**：从主设置“隐私与数据”或浏览器内设置发起按源/全档案清除时，受影响活跃标签与运行中 Service Worker 先被停止/关闭，清除后页面刷新确认不再残留且不会被正在运行的 SW 或旧页内存态立即写回；若存储引擎返回清理失败，UI 明确呈现失败状态而非假成功。
- **代理浏览拿不到手动登录态**：手动工作区已存在登录 Cookie 后，启动 `mode: "agent"` 访问同一域名，请求侧与页面脚本侧观测不到手动 Cookie 或登录态（继续严格使用独立无 `persist:` 临时 `Session`）。
- **临时聊天与无痕标签不落盘**：`temporary: true` 会话内专属视图及窗口工作区手动新建的“无痕标签页”均使用无 `persist:` 内存分区，写入测试 Cookie 关闭后不留磁盘痕迹，且不与持久档案互串；渲染进程伪造或省略 `temporary` 标头时 Main 仍按权威会话状态拦截。
- **加密密钥不可用时退回无痕**：注入模拟 `safeStorage`/密钥不可用或未满足加密前提场景，启动手动浏览器不会落盘创建持久 Cookie，同时可观察到显式告警提示且当前浏览仍可在临时无痕 `Session` 正常工作。
- **打包产物 fuse 状态验收**：通过打包/构建检查脚本直接读取生成产物中的 Electron 可执行文件 fuse 位，断言 `cookieEncryption` 已正式处于启用状态（`FuseV1Options.EnableCookieEncryption` 为启用）。
- **共享多标签断链保护**：同持久档案打开多个标签时，关闭其中一个标签，其余标签的网络代理与请求不中断且持久存储不被清空。

### 验证命令

- `npm run check:storage-boundary`
- `npm test`
- `npx tsc -p tsconfig.main.json --noEmit`
- `npx tsc -p tsconfig.preload.json --noEmit`
- `npx tsc -p tsconfig.renderer.json --noEmit`
- `npm run build`
- `npm run package:win:dir`（或对应 fuse 构建检查脚本核验发布产物中 `cookieEncryption` fuse 状态，不留未验证构建垃圾进入仓库追踪）

---

## PR C：左侧分隔线拖拽修复（仓库布局整体调整完成后实施）

### 施工包

- [ ] **包 C1 — 真机事件链核实与扩展命中区手势捕获修复**：在整体布局重构后的基线上实测 Windows 下鼠标跨越原生 `WebContentsView` 的截断事件与 `ResizeObserver` 纯坐标位移同步表现，参照右栏 `RightInspector` `data-shielded` 方式，为外层 `ff-dock-separator`（含 `resizeTargetMinimumSize` 扩展命中区）与 `ff-sidebar-resizer` 接入拖动起止状态、`pointerup`/`cancel`/`blur`/卸载兜底与松手后最终 `bounds` 重测同步。

### 涉及的文件

- `src/renderer/react/features/chat/pages/ChatPage.tsx`
- `src/renderer/react/features/chat/components/ChatPageInspector.tsx`、`src/renderer/react/features/chat/components/ChatPageNavigation.tsx`
- `src/renderer/react/features/chat/components/RightInspector.tsx`、`src/renderer/react/features/chat/components/RightInspector.css`
- `src/renderer/react/features/chat/workspace/ManualBrowserTab.tsx`
- 分栏拖拽交互测试与 E2E 浏览器拖动验收用例

### 测试要点

- **拖动屏蔽与复原**：从 `ff-dock-separator` 中心及外溢命中区按下拖动时，`RightInspector` 进入屏蔽态并通知主进程脱离原生 `WebContentsView`；无论正常松手、拖拽中窗口 `blur` 或 `pointercancel` 都能恢复网页显示并准确对齐新 `bounds`（涵盖网页区域向左/向右大幅缩放）。

### 验证命令

- `npm test`
- `npx tsc -p tsconfig.main.json --noEmit`
- `npx tsc -p tsconfig.preload.json --noEmit`
- `npx tsc -p tsconfig.renderer.json --noEmit`
- `npm run build`

---

## 负责人需要知道的风险

1. **D1-B（后台禁止点击与输入）**：页签切走、窗口隐藏或失焦期间，Agent 只能继续完成 `observe` 及不改变页面状态的只读步骤；一旦工作流下一步需要 `click`、`type` 或跳转新页面，任务将挂起等待用户切回该会话窗口，不会在后台全自动推进多步交互操作。
2. **D7（`cookieEncryption` 启用后不可关回及明文边界）**：Electron 的 `cookieEncryption` fuse 一经在发行版启用并生成加密 Cookie，后续升级**不可再将 fuse 改回关闭**，否则老用户既有 Cookie 存储会整体不可用；同时即使开启该 fuse，Windows DPAPI 也不防同一系统登录账户下的其他本地进程解密读取，且 Chromium 中的 `localStorage` 与 `IndexedDB`（包括保存于其中的会话 Token）不享受同等级系统加密保护。
3. **D8（关闭全部主窗口停止运行）**：在未完成无任何父 `BrowserWindow` 环境下 Electron `43.7.0` `WebContentsView` 保活与定时器节流真机实测前，用户关掉全部聊天窗口（即使托盘仍驻留）将**直接终止**正在驱动浏览器的后台 Run。

---

## 回退方式

- **PR A 回退**：不涉及持久化磁盘格式变更，确认需要回退时按 PR A 改动文件整体撤销，恢复现有统一绑定窗口目标的 Owner 与同步 `hostVisible` 校验即可，无数据迁移影响。
- **PR B 回退（需特别关注数据与 fuse）**：
  1. 若代码回退到无持久化内存 `Session` 版本，已落盘在 `%APPDATA%\Firefly-1.2.0\Partitions\firefly-manual-default`（及隔离测试目录）的本地文件不会自动被旧版本加载；回退发布说明需提供一次性清理提示或启动清理钩子删除残留 `Partitions/` 目录；
  2. 若已随 PR B 向外部发布启用了 `cookieEncryption` fuse 的构建，**严禁在继续保留旧 `Cookies` 数据库的前提下直接发一个关闭该 fuse 的回退包**（否则会导致 Cookie store 不可用）；回退发布构建时若必须关闭 fuse，必须配套执行受影响持久分区的安全重置/清除升级策略。
- **PR C 回退**：纯前端布局交互修复，不涉及存储与权限格式变化，按 PR C 文件撤销即可完整回退。
