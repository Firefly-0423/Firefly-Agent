# 更新日志 / Changelog

- 适用版本：`v1.2.0`（仅涵盖 `v1.1.4` 之后合入 `dev/firefly-1.2.0` 的更新，已核对至合入的 #131；不包含此前已归入 1.1.x 阶段或未合入 `dev` 的历史条目）。

---

## 1.2.0

### 中文

### 升级须知

- **独立 1.2.0 数据目录，不迁移 1.1.x 旧数据（#62）**：1.2.0 正式版启用独立本地数据目录（`%APPDATA%\Firefly-1.2.0`）并同步更新安装器开机自启配置，不会读取、修改或迁移 1.1.x 版本的对话记录与设置，原有 1.1.x 数据目录将原样保留。

### 新功能

- **提醒小窗内直接查看并处理工具审批（#93）**：在系统提醒小窗点击“查看审批”可展开待确认工具的名称、所属会话、搭档助手与参数摘要，并在核验有效后直接批准或拒绝；即使聊天页面已经切走或刷新，也能从提醒小窗完成确认。
- **任务运行中支持“立即补充”并查看进程内提示气泡（`5f18caa`、#99、#104）**：Work 与 Code 模式任务执行期间，排队消息可标记为“立即补充”或及时撤回（过晚撤回时提示已交给当前运行）；补充内容发往模型时会附带明确提示使其先核对已完成工作再继续，并在任务步骤流中显示为“你补充了”气泡且在刷新后保留位置。
- **Code 模式支持完整读取常见办公与 PDF 文档附件（`5f18caa`）**：在 Work 模式之外，Code 模式现也支持按确认后的读取范围完整读取 `.docx`、`.xlsx`、`.pptx` 与 `.pdf` 附件内容（支持工作区外文件访问档位控制与大文件分段读取提示）。

- **刷新聊天页后仍能找回任务和最终回复（#121）**：页面能识别原任务是否仍在运行或正在收尾，结束后把结果填回原消息。实时输出的接回另行处理。
- **原生 cron 定时计划（#128）**：插件的周期计划可带时区。错过触发、跳过一轮或暂停再恢复后，会排到下一次符合条件的时间。

### 改进

- **后台任务脱离聊天页面生命周期继续运行（#95）**：任务执行期间切换会话、刷新聊天页或关闭聊天窗口时，后台正在运行的任务不再被意外取消，主进程可继续执行并保存会话轨迹（注：刷新页面后重新接入实时流式输出与浏览器独立跨会话运行能力仍在后续开发计划中）。
- **接管超时提示更明确并支持会话级队列暂停（#91、#102）**：点击“终止并重开”时若旧任务在宽限期内尚未收尾，界面停止无限转圈，明确提示“旧任务尚未停止，未启动新任务”，并仅暂停当前会话的队列自动派发（其他会话不受影响）直到旧任务结算或用户手动重试。
- **打开会话读取插话凭据时不再整份重读运行快照（#107）**：打开包含运行中补充消息的 Work 或 Code 会话时，系统改为直接从内存读取已保存的插话交付凭据，减少大任务记录加载开销。
- **瞬时模型请求限流与网关波动自动退避重试（`432e609`）**：遇到 429 限流、502/503/504 网关异常或 529 过载时自动退避重试（最多两次，取消任务时立即中断等待），减少临时网络或服务波动导致的任务失败。

### 行为变化

- **浏览器页面在切换会话后可以保留（#117、#122）**：运行持有的页面可继续后台只读观察。点击、输入和跳转需等待页面重新可交互。其他会话看不到该页面。
- **文件访问权限收敛到三档（#123）**：只读、请求审批、完全访问。

### 修复

- **修复项目里上传过附件后，新任务一开始就失败的问题（#112）**：在同一项目中上传过文件后，新开的 Work 或 Code 任务会在读取历史时报错。现在可以正常读取带附件的历史，附件只作为文字记录带入。该问题自 v1.1.4 起存在。
- **修复插件示例正常停止后丢失状态的问题（#111）**：示例插件停止再启动后会保留之前保存的状态。
- **修复 Chat 误入计划模式的问题（#108）**：普通聊天不再接收计划审批，也不会因为旧的计划批准而自动发出下一条消息。
- **修复主窗口仅失焦时右侧浏览器变空白的问题（#106）**：截图（如 `Win+Shift+S`）或切换到其他程序导致主窗口失去焦点但仍可见时，右侧内置浏览器保留当前网页画面不再空白；仅在窗口隐藏、最小化或切换会话时才收起视图（恢复焦点后仍需重新读取页面才会继续代理操作）。
- **修复任务结束存档失败时清空回答或误报已保存的问题（#90）**：将任务结果判定与终态落盘拆分，写入失败时最多自动重试三次，确认存盘成功才返回已保存状态；即便写盘持续失败也保留屏幕上的已生成回答并提醒未保存。
- **修复被中断任务的旧工具调用行一直显示“等待中”的问题（#100）**：重新打开此前意外中断的会话时，当时仍停留在进行中的工具步骤（例如等待用户回答的澄清提问）会自动展示为已结束（“上次运行已中断”），不改写历史记录也不重放工具。
- **修复运行中插话写入异常时丢失或错位重放的问题（#97）**：调整写入顺序为先确认提交聊天历史再落会话记录，避免同一批补充部分失败时丢失前面已写条目，或在后续新回合误把半截未显示的记录送给模型。
- **修复审批弹窗跨会话误投问题（#92、#93）**：严格按运行归属路由工具审批，禁止把找不到原运行的审批卡错塞进当前正打开的其他会话窗口。
- **修复运行被占用拒发消息误记成功及微信无效消息异常（#82、#102）**：当因旧任务仍在收尾而拒绝直接发送时，新消息不再被错误标记为已发送而悄无声息丢失；同时丢弃缺少发送者标识的微信异常轮询消息，避免连带报错或泄露内容。

- **长附件阅读提示更清楚（#118）**：Chat 无法完整读取长附件时，提示改用 Work。
- **文档索引恢复可用（#116）**：修复文档检索服务因为无法启动而不能建立索引的问题。
- **设置页可用 Esc 关闭模型候选，放弃编辑会重置提示（#120）**。

### 插件 SDK

- **插件开发与授权（#129、#131）**：SDK 提供插件公开接口、测试宿主和运行入口。插件工具按风险和授权使用，插件提供的上下文按不可信资料处理。实际启用和能力开放仍以应用接线及实机验收为准。

- **密钥、定时任务与插件进程（#124–#127）**：提供按插件隔离的加密密钥存储、需要确认的定时任务、清单与打包检查，以及独立插件进程。具体插件能使用的能力取决于声明和用户授权。

### 工程与文档

- **设置页继续按面板拆分（#110、#114）**：通用、偏好、外观和 API 面板各自成为独立模块，设置页入口收敛到约 110 行，冷启动读取次数不变。
- **仓库开发和构建改用 pnpm 12.10.1（#109）**：依赖安装、脚本和 CI 统一使用 pnpm；插件 SDK 仍通过 npm 发布。
- **Vite 与 Vitest 配置改用 `.mts`（#115）**：配置文件改为 ESM；Code 模式的文件工具和语言服务同步识别 `.mts` 为 TypeScript。
- **主进程七层架构重构与持久边界守护（#57、#58、#59、#60、#67–#69、#75）**：完成主进程自底向上七层重组、记忆与运行子模块内部定序、循环引用清理与未引用模块移除，并将全部主进程日志收敛至统一日志通道，通过自动化架构测试长期守住引用方向及测试代码与生产编译隔离。
- **预加载桥接、设置页拆分与事件退订统一（#66、#73、#74、#76–#78、#85–#87）**：先补全契约测试再将预加载入口与设置页主模块按职责拆分为独立工厂与子模块，并统一预加载侧 IPC 监听器的退订调用方式（#76）。
- **测试断言规范化与核心回归验收体系加固（#64、#65、#72、#79–#81、#83、#88、#89、#91）**：围绕安全拒绝、记忆上下文、渠道请求与运行恢复加固错误码与副作用断言，建立涵盖并发接管与队列派发的聊天页回归用例库。
- **开发基线升级、诊断收敛与文档体系整理（#61、#63、#70、#71、#84、#94、#98、#101）**：将开发与构建基线升至 Node.js 24+（#61）；统一二级记忆激活状态存储大小写（#71）；将一次性历史预算诊断开关限定在开发构建启用（#70）并支持通过环境变量覆盖验证驱动的输出基目录（#84）；整理分类无日期化项目文档、免责声明与浏览器拆分定稿设计（#98，其剩余隔离能力待后续开发）。

---

### English

### Upgrade Notice

- **Isolated 1.2.0 user data directory with no automatic 1.1.x migration (#62)**: Firefly 1.2.0 stores its production conversations, settings, and installer autostart options in a dedicated folder (`%APPDATA%\Firefly-1.2.0`). Existing 1.1.x data directories are never read, altered, or migrated automatically and remain intact.

### New Features

- **Review and answer tool approvals directly from the reminder toast (#93)**: Clicking "View approval" in a toast reminder inspects the pending tool, target session, partner agent, and arguments after Main verifies the request, letting you approve or deny even if the main chat view switched or reloaded.
- **In-run "Send Now" supplements with live process bubbles (`5f18caa`, #99, #104)**: In Work and Code modes, queued messages can be marked to inject mid-run or withdrawn before handoff (with a notice if already handed off). Injected messages include a clear prompt note so the model reviews finished work first, appear in the step stream as "你补充了" bubbles, and keep their position across reloads.
- **Full Office and PDF attachment reading in Code mode (`5f18caa`)**: Extends confirmed full-text reading for `.docx`, `.xlsx`, `.pptx`, and `.pdf` attachments into Code mode alongside Work mode.

- **Find the original task and reply after refresh (#121).** The page recognizes an active or settling task and fills in its final reply when saved. Live streaming reattachment is separate.
- **Native cron schedules (#128).** Recurring plugin schedules support time zones and advance after missed runs, skips or a pause.

### Improvements

- **Background tasks continue when switching chats, refreshing, or closing the window (#95)**: Desktop runs now retain independent execution authorization and finish safely in the background without accidental cancellation (note: reattaching live streaming output after a page reload and cross-session browser isolation remain under active development).
- **Clearer takeover timeout feedback and session-scoped queue pause (#91, #102)**: If stopping a busy run times out, the takeover button stops spinning, a banner explains that the prior task has not yet finished, and auto-dispatch pauses only for that session until settlement or manual retry.
- **In-memory lookup for run insertion receipts when opening sessions (#107)**: Opening Work or Code sessions now reads saved insertion delivery receipts from memory instead of reloading every full run snapshot file.
- **Automatic backoff retry on transient model HTTP errors (`432e609`)**: Requests rejected with 429 rate limits, 502/503/504 gateway errors, or 529 overload automatically retry up to twice while honoring immediate user cancellation.

### Behavior Changes

- **Browser pages can survive a conversation switch (#117, #122).** A run can observe its page in the background. Clicks, typing and navigation wait until the page is interactive again. Other conversations cannot see that page.
- **Three file access levels (#123).** Choose read-only, ask for approval or full access.

### Bug Fixes

- **Fixed new tasks failing at start in projects that had attachments (#112)**: After a file was uploaded in a project, new Work or Code tasks there failed while reading history. History with attachments now loads, with attachments carried as text records only. The issue existed since v1.1.4.
- **Fixed plugin examples losing their state after a normal stop (#111)**: Example plugins keep their saved state when stopped and started again.
- **Fixed Chat entering plan mode (#108)**: Ordinary chats no longer accept plan approvals, and an old plan approval no longer sends a follow-up message.
- **Fixed right-hand browser going blank when the main window only loses focus (#106)**: Taking screenshots (e.g. `Win+Shift+S`) or switching to another app no longer clears the visible right-hand browser pane; the view now detaches only on minimize, hide, or session switch (agent interactions still wait until focus returns and the page is re-observed).
- **Fixed terminal persistence failures clearing answers or issuing false save receipts (#90)**: Separates run completion from saving, retries failed disk writes up to three times before reporting persistence, and keeps generated answers on screen with an unsaved notice if writes fail.
- **Fixed interrupted runs leaving tool rows stuck spinning on reopen (#100)**: Reopening a previously interrupted chat renders leftover running tool steps (such as clarification prompts waiting for input) as ended ("上次运行已中断") in the UI without modifying stored records or replaying tools.
- **Fixed mid-run message insertions being lost or replayed out of turn (#97)**: Commits insertions to chat history before writing model transcripts so partial write errors neither discard committed supplements nor replay hidden fragments in later runs.
- **Fixed approval routing leaks across conversations (#92, #93)**: Prevents unowned or detached approval cards from falling back into whichever unrelated conversation happens to be visible.
- **Fixed busy-rejected messages silently dropping & malformed WeChat inbound items (#82, #102)**: Ensures submissions refused due to an active run stay interrupted/pending rather than marked sent, and safely discards WeChat polled messages lacking sender IDs without leaking details.

- **Clearer long attachment guidance (#118).** Chat recommends Work when it cannot read a long attachment in full.
- **Document indexing works again (#116).** Fixes a startup failure that prevented document indexes from being built.
- **Model picker and discard behavior in Settings (#120).** Escape closes the picker, and discarding edits resets the status.

### Plugin SDK

- **Plugin development and consent (#129, #131).** The SDK adds public APIs, a test host, and a plugin runtime. Tool access depends on risk and user consent; plugin context is treated as untrusted data. Availability depends on desktop integration and acceptance testing.

- **Secrets, schedules and plugin processes (#124–#127).** Adds encrypted per-plugin secret storage, schedules that require confirmation, manifest and package checks, and separate plugin processes. Capabilities depend on declarations and user authorization.

### Engineering & Docs

- **Settings page split into per-panel modules (#110, #114)**: General, preferences, appearance and API panels are now separate modules; the entry shrinks to about 110 lines with the same cold-start reads.
- **Development and builds now use pnpm 12.10.1 (#109)**: Installs, scripts and CI use pnpm; the plugin SDK is still published with npm.
- **Vite and Vitest configs moved to `.mts` (#115)**: The configs are ESM files, and Code mode's file tools and language server treat `.mts` as TypeScript.
- **Main-process 7-layer reorganization and automated dependency guardrails (#57, #58, #59, #60, #67–#69, #75)**: Reorganized `src/main` into strict upward-forbidden layers with sub-module ordering, broke circular imports, removed unreferenced modules, centralized main logging, and isolated test helpers from production builds.
- **Preload bridge & Settings page modularization and listener cleanup (#66, #73, #74, #76–#78, #85–#87)**: Added contract tests and split the preload bridge and Settings entrypoints into focused factories/helpers while standardizing preload IPC listener removal on `removeListener` (#76).
- **Hardened error-code assertions and ChatPage regression coverage (#64, #65, #72, #79–#81, #83, #88, #89, #91)**: Strengthened unit/integration assertions across security, permissions, memory, channels, and agent modules and established regression suites for persistence, takeover, and queueing.
- **Toolchain baseline, diagnostic tightening & documentation overhaul (#61, #63, #70, #71, #84, #94, #98, #101)**: Updated toolchain support to Node.js 24+ (#61); standardized lowercase L2 memory activation state persistence (#71); restricted legacy budget diagnostic switches to dev builds (#70) with env-overridable verify driver base directories (#84); categorized undated project docs and finalized the browser owner/session split design (#98, implementation remaining).

---
