# 提醒与界面体验施工计划

状态：待施工
规格：无独立规格；依据外部参考文档盘点条目与负责人 2026-11-12 的决定（权限档位见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2）。

> 路径说明（2026-11-13）：主进程已按七层重组（#57、#58），本文的文件路径和符号名已换成新位置（如 `src/main/agent/loop/agent-loop.ts`、`runAgentLoop`）。`文件:行号` 里的行号仍是重组前（`39987fc`）的位置，施工时以符号名为准，并在进度文档记录实际行号。

**目标：** 让用户离开聊天窗口后仍能感知需要处理的事情，并从提醒直接回到对应会话、审批、选择题、抽查题或定时任务记录。运行中继续输入、排队和停止当前运行保持清晰、可靠；图片无法发送或分析时，由界面明确告知原因，不依赖模型自行解释。保留 Firefly 已有的队列、上下文快照和消息缓存实现，补足跨进程定位、失败反馈、计划阶段纯策略、异步设置定位及运行验收。适用功能覆盖 Chat、Work、Code，按会话真实模式打开，不因提醒改变模式、工作区或权限。

| 功能 | Chat | Work | Code |
|---|---|---|---|
| 提醒定位 | 打开所属会话及实际可用交互 | 同左，包含伙伴请求 | 同左，计划审批同时展开计划内容 |
| 定时任务提醒 | 打开共享任务面板及运行记录 | 同左 | 同左 |
| 运行中输入 | 普通 Enter 入队，Shift+Enter 换行，停止按钮独立 | 同左，保留工作区要求 | 同左，保留工作区要求 |
| 图片失败反馈 | 附件状态显示中文原因 | 附件及工具结果显示原因 | 同左 |
| 计划只读限制 | 会话进入计划状态时生效 | 自身及继承父计划状态的执行均生效 | 同左 |
| 上下文刷新 | 支持压缩的会话成功后立即更新；不支持则明确提示 | 同左 | 同左 |
| 性能验收 | 包含分段聊天表现 | 包含工具、过程和伙伴结果 | 包含代码、差异及计划表现 |
| 设置搜索 | 共用设置窗口，不受聊天模式限制 | 同左 | 同左 |

**架构：** 扩展 `ToastTarget` 与新增共享 `AttentionNavigationRequest`，从可信调用链补齐审批、选择、抽查、计划审批和定时任务的会话/运行归属，经新增 `CHATS_NAVIGATE_ATTENTION`（`chats:navigate-attention`）在聊天页 ready 后投递到渲染端 `attention-navigation.ts` 状态机，定位交互、计划审批面板或共享 `ScheduledTaskPanel` 的运行记录。图片失败反馈新增共享 `ImageDeliveryIssue` 与 AG-UI 自定义事件 `firefly.image.delivery.issue`，由 `AgentRunController` 按运行和附件身份归并，独立于模型回复展示中文原因。计划阶段新增主进程纯策略模块 `plan-tool-policy.ts`，在 `PLAN_DISCUSSING`、`PLAN_REVIEW` 阶段调用 `resolveEffectKind(definition, args)`，仅 `"read"` 可继续进入原有三档权限（只读 `read-only`、请求审批 `per-action`、完全访问 `full`）检查。设置搜索将入口移到标题栏弹窗，改用 `data-settings-search-id` 稳定目标索引与 `loading / ready / error` 可取消异步定位状态机。

**不改的东西：**
- 本计划仅以 Firefly 为产品源码基线。外部参考文档只用于梳理体验与边界，不引入外部源码、标识或运行依赖。
- 不扩大任何模式的工具可用范围；没有某类交互时，不为验收制造不可见后台运行。
- **移出施工范围（保留现有实现，只补回归与验收）**：
  - 重做输入入口、替换 `Sender`、重建队列（忙时普通 Enter 入队已在 `ChatComposer.tsx:373` 实现）；等待审批或提问期间首版保留交互面板优先，普通流式运行继续允许排队。
  - 再次实现手动压缩后广播和快照刷新（已在 `src/main/features/sessions/chats-ipc.ts:178,192,196` 与 `ChatPage.tsx:340,532,959` 实现）；不通过移除记忆运行时保护（`MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED`）来实现本主题。
  - 重复增加流式消息缓存或全面替换渲染器（先补三模式测量，发现具体失效链后才做局部修改；虚拟化、分页、渲染器迁移不作为默认施工项）。
- 保留现有 `CHATS_REACT_SWITCH_SESSION` 字符串契约，避免改变无关调用方；保持现有 Toast 生命周期（点击消隐不等于业务结算，计划与选择分类保持互斥）；定时任务提醒使用现有聊天窗口任务面板 `ScheduledTaskPanel`，不新增独立任务窗口。
- 不引入新的独立视觉配置系统或视觉服务，不改变工具结果为图片块的协议，不自动转码 BMP/SVG，不扩大文件访问权限。
- 不在本主题顺带改造计划状态持久化、重试分类或全局并发策略；不在首版设置搜索增加搜索历史、多层分类浏览或全设置页重构。
- 当前 `package.json` 的版本仍为 `1.1.4`。统一版本号属于发布工作，本主题不单独修改版本。不修改 CI 配置、阈值、测试超时或检查工具。

## 现状

### 核对基线与施工边界

- 当前 HEAD 为 `c991111efa68087b9d625868179c03fea1b83e14`，工作树干净；当前目录处于 detached HEAD。`dev/firefly-1.2.0` 分支存在，但此目录未检出该分支。实施前须重新核对实际承接分支和提交。
- 已完整读取 `AGENTS.md`，测试和验证按其中“修改与验证”“测试断言写法”执行。
- 模块边界沿用 `README.md:211` 的职责表：界面与 preload 属桌面界面层；Harness、权限与伙伴执行属 Agent 核心层；图片适配属记忆与模型层；定时任务属入口层。
- 当前 `package.json` 的版本仍为 `1.1.4`。统一版本号属于发布工作，本主题不单独修改版本。
- 正式运行配置目前仍将数据放在 `%APPDATA%\Firefly`，未区分 1.2.0；开发配置已经支持独立目录。证据：`src/main/base/identity/runtime-profile.ts:55`、`:69`，`src/main/base/storage/storage-context.ts:35`。
- 本次只进行了只读核对，未执行测试、构建、性能脚本或应用启动；这些命令会产生文件，列入后续实施验证。

### 提醒中心已有生命周期，缺少精确落点

已具备：

- 审批、选择、抽查、计划审批和定时任务事件：`src/main/platform/interaction/toast-events.ts` 的 `ToastEventMap`。
- 可见条目与去重记录分离、结算清退、通知超时、计划与普通选择互斥：`src/main/platform/toast/toast-service.ts` 的 `visible`、`seenKeys`、`planRuns`、`settle`。
- 独立窗口、不抢焦点展示、显示器回退及高度调整：`src/main/platform/toast/toast-window.ts` 的 `chooseDisplay`、`updateHeight`、`syncVisibility`。
- 点击只上传 Toast 标识，主进程查找目标：`src/main/platform/toast/toast-service.ts:240`。

实际缺口：

- `ToastTarget` 只有会话或聊天窗口目标：`src/shared/toast-types.ts` 的 `ToastTarget`。
- 审批、选择和抽查通过 `waitingForChat` 仅打开聊天窗口；计划审批仅带 `sessionId`：`src/main/platform/toast/toast-service.ts:139`、`:148`、`:201`，以及 `onPlanReview`。
- 定时任务完成事件已有 `taskId`、`schedulerRunId`，但点击仍打开聊天窗口：`SchedulerFinishedEvent`、`onSchedulerFinished`。
- 当前产品已有 `ScheduledTaskPanel`，由 `ChatPagePanelHost` 的 `"scheduled"` 分支承载，不需要新增独立任务窗口。证据：`src/renderer/react/features/chat/components/ChatPagePanelHost.tsx:11`。
- 当前导航只传会话字符串，并在渲染页 ready 后补发：`ReactChatSessionDispatcher`、`src/main/features/sessions/chat-ui-ipc.ts:215`、`src/preload/index.ts:1163`。精确定位需要跨越这条就绪链路。

### 忙时普通 Enter 入队已经实现

- `ChatComposer.tsx:373` 的 `handleSenderKeyDown` 在忙时截获普通 Enter，先处理入队，再阻止 `Sender` 内置提交；不能仅凭 `loading={modelBusy}` 判断入口不可达。
- 真实组件测试未替换 `Sender`，已有忙闲 Enter、停止、Shift+Enter、输入法组合输入和队列操作断言。证据：`ChatComposer.sender-integration.test.ts:61`、`:84`、`:98`、`:107`。
- 页面按当前会话计算忙闲和队列：`ChatPage.tsx:935`、`:938`；主进程已有队列 IPC、认领与持久化逻辑：`src/main/features/sessions/chats-ipc.ts` 的 `CHATS_PENDING_*` 处理器。

**移出施工范围：重做输入入口、替换 `Sender`、重建队列。** 保留三模式组件回归和 Electron 验收。

审批或提问期间，`ComposerSlot` 当前以交互面板替换输入区域，见 `src/renderer/react/features/chat/components/ComposerSlot.tsx`。负责人已决定首版保留交互面板优先；普通流式运行继续允许排队，同时展示输入框另行设计。

### 图片路由已收敛，用户反馈仍不闭合

- 当前路由只有 `direct` 和 `reject`，不是独立视觉模型优先的旧方案：`src/main/model/vision/image-router.ts` 的 `ImageRoute`、`resolveImageRoute`。
- Anthropic 直发仅接受 PNG、JPEG、WebP、GIF；其他嵌入格式转换为模型上下文里的文本占位：`src/main/model/providers/anthropic-adapter.ts:20`、`:49`。
- `read_image` 仍接受 BMP、SVG：`src/main/agent/tools/fs-tools.ts:290`、`:305`。
- 附件拒绝和转述失败主要写入模型上下文，不能据此证明用户界面一定显示原因：`src/main/agent/runtime/build-options.ts` 的 `withImageRejectNotice`、`withCaptionedImageAttachments`。
- 缺少转述回调的函数分支目前仅记录警告并返回原消息，见 `build-options.ts:170`；但正常构造 `captionFallback` 时已经检查回调是否存在，见 `:406`。**不能把该分支直接认定为正常桌面路径已复现的静默丢图。**
- Anthropic 转述端点不可用已有显式拒绝：`resolveCaptionVisionConfig`。不需要重新引入独立视觉配置系统。

### 计划权限优先级已有保护，判断依据仍不够严格

- `prepareToolRuntime` 在完全访问（`full` / `allow_all`）前执行计划限制，审批等待后再次核对，并提供执行前复核：`src/main/agent/runtime/adapter/tool-runtime.ts:61`、`:75`、`:79`。
- 判断仍基于 `risk`；未标风险默认 `"safe"`。调度器的兜底复核也使用同类判断：`src/main/agent/loop/tool-dispatcher.ts` 的 `revalidateToolPermission`。
- `ToolEffectKind` 与 `resolveEffectKind` 已存在，支持静态声明和参数相关解析：`src/main/tooling/registry/tool-registry.ts`。
- `run_shell` 已声明 `effectKind: "unknown"`，并有计划阶段保护：`src/main/agent/tools/builtin-tools/run-shell-tool.ts`。
- Harness 控制工具先于普通注册工具权限链分派：`tool-dispatcher.ts` 的 `isAgentLoopBuiltin` 分支。不能把普通工具的新规则直接覆盖到写计划和用户审批流程。

### 手动压缩的成功刷新链路已经存在，但有适用边界

- 压缩成功后写入 `currentContextUsage`，并广播给包括发起窗口在内的所有窗口：`src/main/features/sessions/chats-ipc.ts:178`、`:192`、`:196`。
- 页面收到变更后重读会话；`selectSession` 比较会话级与消息级快照时间，更新显示：`ChatPage.tsx:340`、`:532`。
- 当前概览优先使用会话级快照：`ChatPage.tsx:959`。
- 由当前记忆运行时拥有的会话会返回 `MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED`，不会进入旧压缩链：`chats-ipc.ts:123`。

**移出施工范围：再次实现压缩后广播和快照刷新。** 保留成功路径回归、拒绝路径反馈及真机验证；不通过移除记忆运行时保护来实现本主题。

### 流式消息缓存已有实现，缺少当前版本测量

- 单消息对象缓存已存在：`ChatMessageList.tsx` 的 `MessageItemsCacheState`、`assembleMessageItems`。
- 消息列表、角色配置和文件链接环境已有 `useMemo`：`ChatMessageList.tsx:736`、`:750` 及 `fileEnvironment`。
- 导航、侧栏已经 `memo`，相关回调已有稳定引用处理：`ChatPageNavigation.tsx:61`、`ConversationSidebar.tsx:137`、`ChatPage.tsx:1025`、`:1059`、`:1181`。
- 已有缓存身份和顺序测试：`ChatMessageList.test.ts:228`、`:242`、`:250`。
- 已有 `perf:chat-baseline`、生产与 profiling 通道、固定数据集和探针：`scripts/perf/chat-renderer-baseline.mjs`、`chat-perf-probe.ts`。
- 现有性能 fixture 固定为 Chat：`src/renderer/react-perf/fixture.ts:124`。

**移出施工范围：重复增加缓存或全面替换渲染器。** 先补三模式测量，发现具体失效链后才做局部修改。

### 设置搜索已有基本能力，异步定位与条件判断不足

- 当前 DOM 索引、当前语言、多关键词全部匹配、排序、滚动和高亮已有实现：`src/renderer/settings/shared/search.ts` 的 `collectSettingsEntries`、`searchEntries`、`go`。
- 入口位于侧栏：`src/renderer/settings/index.html:54`。
- `go` 持有旧 DOM 元素并立即滚动；而切页会异步加载任务、渠道、伙伴和用量面板：`src/renderer/settings/settings.ts` 的 `switchSection`、`loadSubagents`、`loadUsage`。
- 条件判断目前主要检查 `hidden`、`is-hidden`，不能覆盖使用内联 `display` 隐藏的项。例：`src/renderer/settings/search/panel.ts` 的 `syncSearchConfigVisibility`、`syncSearchEngineRows`。
- 已有语言切换时刷新搜索的接线：`settings.ts:1386`。

## 全局约束

- **1.2.0 数据目录**：正式数据目录为 `%APPDATA%\Firefly-1.2.0`（负责人 2026-11-12 决定）。继续由 `resolveRuntimeProfile` 和 `StorageContext` 统一提供路径；配置、会话、记忆、日志、缓存和 Electron `sessionData` 全部落在新目录体系；不探测、不读取、不复制、不导入 1.1.x 数据，也不以旧目录作为失败回退；开发、test、smoke 使用本次专用空隔离根，避免复用已有开发数据；若其他主题已交付统一目录切换，本计划只接收该契约并做回归，不重复修改启动模块。
- **权限档位三档契约**：用户可选的权限档位只有三档（只读 `read-only`、请求审批 `per-action`、完全访问 `full`），1.2.0 删除旧值 `project-read-only` 和 `scoped`（见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2）。计划只读限制先于完全访问（`full`）生效；读取工具进入原有三档权限检查后，仍受目录、网络、会话权限和取消限制。
- **跨进程定位与安全边界**：不使用任意 CSS 选择器作为目标，不接受 Toast 渲染进程反传路径或业务目标。缺失归属时只允许安全兜底，不推测为当前可见会话，不扫描历史正文寻找目标。Toast 的读取与操作 IPC 都校验来源窗口；未知 Toast 标识不触发导航。
- **隐私脱敏与测试断言纪律（`AGENTS.md` 12 条）**：`ImageDeliveryIssue` 仅携带运行、附件身份、阶段和稳定错误码，不携带 base64、凭据或原始服务响应；设置搜索动态条目只索引公开名称和说明，不索引输入框值、密钥、地址或配置正文。所有新增文件系统测试使用独立临时目录和真实文件，结束后清理；模型、网络、窗口和系统服务使用可预测替身。时间窗口使用假定时器，覆盖边界前、边界、边界后并恢复。稳定结果比较完整对象或有序列表。

## 文件清单

### 新建

- `src/shared/attention-navigation.ts`
- `src/renderer/react/features/chat/pages/attention-navigation.ts`、`src/renderer/react/features/chat/pages/attention-navigation.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.attention-navigation.test.ts`
- `src/shared/image-delivery.ts`
- `src/renderer/react/features/chat/pages/run/image-delivery.test.ts`
- `src/main/agent/runtime/plan-tool-policy.ts`、`src/main/agent/runtime/plan-tool-policy.test.ts`、`src/main/agent/loop/tool-dispatcher.plan-policy.test.ts`
- `src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts`
- `src/renderer/settings/shared/search-target.ts`、`src/renderer/settings/shared/search-target.test.ts`
- `src/renderer/settings/shared/search-dialog.ts`、`src/renderer/settings/shared/search-dialog.test.ts`

### 修改

- `src/main/base/identity/runtime-profile.ts`、`src/main/base/identity/runtime-profile.test.ts`、`src/main/app/identity-preflight.test.ts`、`src/main/base/storage/storage-context.test.ts`、`README.md`、`README.en.md`
- `src/shared/toast-types.ts`、`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/shared/permission-approval.ts`
- `src/main/platform/permission/permission.ts`
- `src/main/agent/runtime/adapter/tool-runtime.ts`、`src/main/agent/runtime/adapter/tool-runtime.test.ts`、`src/main/agent/loop/tool-dispatcher.ts`、`src/main/agent/loop/types.ts`、`src/main/agent/runtime/adapter/event-mapper.ts`、`src/main/agent/loop/plan-tools.test.ts`
- `src/main/agent/tools/builtin-tools/run-shell-plan-boundary.test.ts`、`src/main/agent/tools/fs-tools.ts`（及经核实的内置读取工具 `effectKind` 声明）
- `src/main/platform/interaction/user-choice.ts`、`src/main/features/chat/agui-bridge.ts`、`src/main/agent/runtime/image-caption.test.ts`
- `src/main/agent/runtime/pop-quiz.ts`、`src/main/model/vision/image-router.ts`、`src/main/model/vision/image-router.test.ts`、`src/main/agent/runtime/build-options.ts`、`src/main/agent/runtime/build-options.test.ts`、`src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/agent-runtime.test.ts`、`src/main/agent/runtime/firefly-agent.ts`、`src/main/model/providers/anthropic-adapter.ts`（及现有 Anthropic 适配器测试）
- `src/main/platform/interaction/toast-events.ts`、`src/main/platform/interaction/toast-events.test.ts`、`src/main/platform/toast/toast-service.ts`、`src/main/platform/toast/toast-service.test.ts`
- `src/main/platform/windows/window-activation.ts`、`src/main/platform/windows/window-activation.test.ts`、`src/main/app/shell-bootstrap.ts`
- `src/main/platform/windows/window-manager.ts`、`src/main/platform/windows/create-aux-windows.ts`
- `src/main/platform/windows/react-chat-session-dispatcher.ts`、`src/main/platform/windows/react-chat-session-dispatcher.test.ts`、`src/main/features/sessions/chat-ui-ipc.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts`、`src/main/features/sessions/chats-pending-queue.test.ts`、`src/main/features/sessions/chats-ipc.test.ts`
- `src/renderer/react/features/chat/pages/chat-page-bridge.ts`、`src/renderer/react/features/chat/pages/ChatPage.tsx`、`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`、`src/renderer/react/features/chat/pages/queue-actions.test.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.ts`
- `src/renderer/react/features/chat/components/ComposerSlot.tsx`、`src/renderer/react/features/chat/components/InteractionPanel.tsx`、`src/renderer/react/features/chat/components/PlanReviewPanel.tsx`、`src/renderer/react/features/chat/components/ChatPagePanelHost.tsx`、`src/renderer/react/features/chat/components/ScheduledTaskPanel.tsx`、`src/renderer/react/features/chat/components/ScheduledTaskPanel.test.ts`、`src/renderer/react/features/chat/components/scheduled-task-model.ts`、`src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`、`src/renderer/react/features/chat/components/ContextUsageRing.tsx`、`src/renderer/react/features/chat/components/ContextUsageRing.test.ts`、`src/renderer/react/features/chat/components/SlashCommandMenu.tsx`、`src/renderer/react/features/chat/components/SlashCommandMenu.test.ts`、`src/renderer/react/features/chat/components/ChatMessageList.test.ts`（及实际附件展示组件与测试）
- `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`
- `src/renderer/react-perf/fixture.ts`、`src/renderer/react-perf/fixture.test.ts`、`src/renderer/react-perf/fake-bridges.ts`、`src/renderer/react-perf/main.tsx`、`scripts/perf/chat-renderer-baseline.mjs`（必要时 `chat-perf-probe.ts`）
- `src/renderer/settings/index.html`、`src/renderer/settings/shared/search.ts`、`src/renderer/settings/shared/search.test.ts`、`src/renderer/settings/settings.ts`、`src/renderer/settings/api/agent-routing.ts`、`src/renderer/settings/usage/panel.ts`、`src/renderer/settings/search/panel.ts`、`src/renderer/settings/settings-system.css`、设置侧两份 i18n JSON 及 `src/renderer/settings/settings-i18n-regression.test.ts`

## 施工包

建议合并顺序：施工包 A → 施工包 B → 施工包 C → 施工包 D → 施工包 E → 施工包 F → 施工包 G → 施工包 H → 施工包 I。每包遵循“先补行为测试 → 确认新增断言失败 → 最小实现 → 定向验证”。已有行为只增加回归证据。正式运行验收依赖施工包 A 的数据隔离。原步骤 1 涉及 29 个非测试文件，按开发流程 §5.2 拆分为施工包 B（主进程提醒目标、可信归属与窗口激活分发，15 个非测试文件）与施工包 C（聊天窗口就绪缓冲与渲染端精确落点，14 个非测试文件）。以下新增类型、文件、IPC 和错误码均为拟新增契约，不表示当前源码已经存在。

### 施工包 A：接入 1.2.0 新数据目录

依赖：无（若其他主题已交付统一目录切换，本包只接收该契约并做回归，不重复修改启动模块）
**改动文件：**

| 文件 | 改动 |
|---|---|
| `src/main/base/identity/runtime-profile.ts` | 正式配置切换新目录 `%APPDATA%\Firefly-1.2.0`，保留隔离和路径归属检查 |
| `src/main/base/identity/runtime-profile.test.ts` | 新目录及不访问旧目录测试 |
| `src/main/app/identity-preflight.test.ts` | 验证启动预检使用新路径 |
| `src/main/base/storage/storage-context.test.ts` | 验证所有存储根归属 |
| `README.md`、`README.en.md` | 同步数据位置说明 |

**任务：**

- [ ] A1 切换正式配置至 `%APPDATA%\Firefly-1.2.0` 并验证与 1.1.x 目录完全隔离
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`：① 正式配置启动 → 所有路径精确落入新目录 `%APPDATA%\Firefly-1.2.0`；没有旧目录读取、枚举、迁移和回退调用；② 临时 fixture 中放置旧版标记文件 → 新实例不加载它；旧文件字节不变；③ 新根经 junction 越界或与正式数据重叠 → 断言已有稳定路径错误；没有启动业务存储；④ 新目录不可用 → 明确失败；不尝试旧目录。
  - 实现：修改 `src/main/base/identity/runtime-profile.ts`，并更新 `README.md`、`README.en.md`。
  - 验证：`npm test -- src/main/base/identity/runtime-profile.test.ts`
- [ ] A2 验证启动预检与 `StorageContext` 所有存储根归属新目录
  - 先写的测试：`src/main/app/identity-preflight.test.ts`、`src/main/base/storage/storage-context.test.ts`：启动预检与配置、会话、记忆、日志、缓存、Electron `sessionData` 全部落在新目录体系。
  - 实现：核对并补齐 `identity-preflight.test.ts` 与 `storage-context.test.ts` 的新目录断言。
  - 验证：`npm test -- src/main/base/identity/runtime-profile.test.ts src/main/app/identity-preflight.test.ts src/main/base/storage/storage-context.test.ts`

**验收：** 正式配置、启动预检和全部存储根均落入 `%APPDATA%\Firefly-1.2.0`，旧目录零访问。
**回退：** 数据回退仅在 1.2.0 自身数据范围内进行，不迁移到 1.1.x；应用版本回退不得共用两代目录。
**工作量：** 0.5–1 人日

---

### 施工包 B：提醒目标契约、可信事件归属与窗口激活分发

依赖：施工包 A
**改动文件（非测试文件 15 个）：**

| 文件 | 改动 |
|---|---|
| `src/shared/toast-types.ts` | 扩展 `ToastTarget` |
| 新增 `src/shared/attention-navigation.ts` | 导航请求、目标、错误码 |
| `src/shared/ipc-channels.ts` | 新导航事件常量 `CHATS_NAVIGATE_ATTENTION` |
| `src/shared/permission-approval.ts`、`src/main/platform/permission/permission.ts` | 审批携带可信会话归属 |
| `src/main/agent/runtime/adapter/tool-runtime.ts` | 从运行上下文传递审批所属会话 |
| `src/main/platform/interaction/user-choice.ts`、`src/main/features/chat/agui-bridge.ts` | 选择及计划交互补齐归属 |
| `src/main/agent/runtime/pop-quiz.ts` | 抽查事件补齐会话身份 |
| `src/main/platform/interaction/toast-events.ts`、`src/main/platform/toast/toast-service.ts` | 构造精确目标，保留生命周期及来源校验 |
| `src/main/platform/windows/window-activation.ts`、`src/main/app/shell-bootstrap.ts` | 激活请求携带导航目标 |
| `src/main/platform/windows/window-manager.ts`、`src/main/platform/windows/create-aux-windows.ts` | 复用聊天窗口并传递目标 |
| `src/main/platform/interaction/toast-events.test.ts`、`src/main/platform/toast/toast-service.test.ts`、`src/main/platform/windows/window-activation.test.ts` | 提醒目标与激活测试 |

#### 提醒目标与事件归属设计

扩展 `ToastTarget`，保留现有窗口、会话兜底，新增：
- `interaction`：`sessionId`、`runId`、交互类别、交互标识及适用的 `revision`。
- `plan-review`：`sessionId`、`runId`，定位计划面板及当前计划审批交互。
- `scheduled-task`：`taskId`、`schedulerRunId`，定位任务及该次运行记录。

事件归属从可信调用链补齐：
- 审批由 `prepareToolRuntime` 捕获的父会话身份传入权限请求。
- 选择由 `agui-bridge.ts` 已知的会话和运行身份传入 `user-choice.ts`。
- 抽查由工具调用上下文传入会话身份。
- 定时任务使用现有 `taskId`、`schedulerRunId`。
- 缺失归属时只允许安全兜底，不推测为当前可见会话，不扫描历史正文寻找目标。

新增共享 `AttentionNavigationRequest`，包含请求标识和上述封闭目标。扩展 `WindowActivationRequest` 的聊天激活请求携带该目标；沿用窗口创建、激活和 ready 缓存机制。新增主进程到聊天窗口 IPC：`CHATS_NAVIGATE_ATTENTION`（`chats:navigate-attention`），保留现有 `CHATS_REACT_SWITCH_SESSION` 字符串契约，避免改变无关调用方。

新增导航结果码：

| 错误码 | 界面中文 |
|---|---|
| `E_ATTENTION_TARGET_UNAVAILABLE` | 此提醒对应的内容已结束或不可用 |
| `E_ATTENTION_TARGET_TIMEOUT` | 内容尚未加载完成，请重试 |

保持现有 Toast 生命周期。点击消隐不等于业务结算；计划与选择分类保持互斥。Toast 的读取与操作 IPC 都校验来源窗口；未知 Toast 标识不触发导航。

**任务：**

- [ ] B1 新增 `attention-navigation.ts` 并扩展 `ToastTarget`，补齐审批、选择、抽查、计划与定时任务的可信归属
  - 先写的测试：`src/main/platform/interaction/toast-events.test.ts`：审批、选择、抽查、计划审批、定时任务五类事件分别输入 → 比较生成的完整事件与 `ToastTarget` 归属字段；缺失归属时只允许安全兜底，不推测为当前可见会话。
  - 实现：新建 `src/shared/attention-navigation.ts`；修改 `src/shared/toast-types.ts`、`src/shared/ipc-channels.ts`、`src/shared/permission-approval.ts`、`src/main/platform/permission/permission.ts`、`src/main/agent/runtime/adapter/tool-runtime.ts`、`src/main/platform/interaction/user-choice.ts`、`src/main/features/chat/agui-bridge.ts`、`src/main/agent/runtime/pop-quiz.ts`、`src/main/platform/interaction/toast-events.ts`。
  - 验证：`npm test -- src/main/platform/interaction/toast-events.test.ts`
- [ ] B2 在 `toast-service.ts` 与 `window-activation.ts` 构造精确目标并校验 Toast 来源窗口与生命周期
  - 先写的测试：`src/main/platform/toast/toast-service.test.ts`、`src/main/platform/windows/window-activation.test.ts`：① 五类事件分别输入 → 比较完整 `ToastTarget`；点击只产生一次对应导航，没有批准、作答或任务运行调用；② 关闭、点击、结算与重播交错 → 可见状态和去重状态符合原契约，不重弹、不重复播音；③ 非 Toast 窗口读取或操作 Toast、伪造标识 → 无目标数据泄露，无窗口激活和业务副作用。
  - 实现：修改 `src/main/platform/toast/toast-service.ts`、`src/main/platform/windows/window-activation.ts`、`src/main/app/shell-bootstrap.ts`、`src/main/platform/windows/window-manager.ts`、`src/main/platform/windows/create-aux-windows.ts`。
  - 验证：`npm test -- src/main/toast src/main/platform/windows/window-activation.test.ts`

**验收：** 本包任务 B1–B2 的全部测试通过（3 项场景）；五类提醒点击后精确构造 `AttentionNavigationRequest` 并送达窗口激活层；来源校验、去重与互斥符合契约。
**回退：** 与施工包 C 成组 revert；恢复原有会话/窗口级激活。
**工作量：** 1.5–2 人日

---

### 施工包 C：聊天窗口就绪缓冲与渲染端交互/计划/定时任务精确落点

依赖：施工包 B
**改动文件（`components/` 路径均位于 `src/renderer/react/features/chat/`，非测试文件 14 个）：**

| 文件 | 改动 |
|---|---|
| `src/preload/index.ts` | 新导航事件订阅 API |
| `src/main/platform/windows/react-chat-session-dispatcher.ts`、`src/main/features/sessions/chat-ui-ipc.ts` | ready 前缓存、ready 后投递 |
| `src/renderer/react/features/chat/pages/chat-page-bridge.ts`、`src/renderer/react/features/chat/pages/ChatPage.tsx` | 接收、取消、串联会话与落点选择 |
| 新增 `src/renderer/react/features/chat/pages/attention-navigation.ts` | 定位状态机，隔离异步竞争 |
| `components/ComposerSlot.tsx`、`components/InteractionPanel.tsx`、`components/PlanReviewPanel.tsx` | 交互选择、目标标记和焦点入口 |
| `components/ChatPagePanelHost.tsx`、`components/ScheduledTaskPanel.tsx`、`components/scheduled-task-model.ts` | 任务及运行记录定位，必要时读取更早历史 |
| `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json` | 新导航反馈文案 |
| `src/main/platform/windows/react-chat-session-dispatcher.test.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts`、新增 `pages/attention-navigation.test.ts`、新增 `pages/ChatPage.attention-navigation.test.ts`、`components/ScheduledTaskPanel.test.ts` | 就绪缓冲与渲染落点测试 |

#### 渲染端定位流程设计

导航请求须等聊天页 ready 后发送；同一窗口连续导航以最后请求为准。渲染端流程：
1. 打开目标会话，并按存储中的真实模式切换。
2. 等会话选择完成，再选择交互、展开浮动输入区域或计划面板。
3. 对实际交互容器聚焦和定位，不自动批准、作答或提交。
4. 任务目标打开 `"scheduled"` 面板，展开目标任务历史并定位运行记录；不能只在最近十条中找不到就判断记录不存在。
5. 新请求、手动导航或卸载使旧定位失效，迟到结果不得抢回焦点。

计划提醒先于审批选择卡到达时，允许等待对应交互出现；等待期间展示计划内容，不回退到无关选择卡。内容已结算或删除时显示提示（`E_ATTENTION_TARGET_UNAVAILABLE`），不重建交互。

**任务：**

- [ ] C1 在 `ReactChatSessionDispatcher`、`chat-ui-ipc.ts` 与 `preload` 实现 ready 前缓存与最后请求合并投递
  - 先写的测试：`src/main/platform/windows/react-chat-session-dispatcher.test.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts`：聊天窗口未 ready → 暂不发送；ready 后发送最后请求且仅一次；保留 `CHATS_REACT_SWITCH_SESSION` 字符串契约不变。
  - 实现：修改 `src/main/platform/windows/react-chat-session-dispatcher.ts`、`src/main/features/sessions/chat-ui-ipc.ts`、`src/preload/index.ts`、`src/renderer/react/features/chat/pages/chat-page-bridge.ts`。
  - 验证：`npm test -- src/main/platform/windows/react-chat-session-dispatcher.test.ts src/main/features/sessions/chat-ui-ipc.test.ts`
- [ ] C2 实现渲染端 `attention-navigation.ts` 定位状态机并接入 `ChatPage.tsx`、`ComposerSlot.tsx`、`InteractionPanel.tsx` 与 `PlanReviewPanel.tsx`
  - 先写的测试：`src/renderer/react/features/chat/pages/attention-navigation.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.attention-navigation.test.ts`：① 用户正在其他会话或模式 → 打开真实所属模式及目标；不改变目标会话工作区和权限；② 计划提醒先到、选择卡后到 → 只有计划提醒，卡片到达后定位对应计划交互；③ 同会话存在多个待处理交互 → 选择目标标识对应的交互，不误选第一张卡；④ 点击后交互恰好结算 → 返回 `E_ATTENTION_TARGET_UNAVAILABLE`；不重建卡片、不提交旧答案；⑤ 旧定位请求迟到 → 不覆盖新会话或新落点。
  - 实现：新建 `src/renderer/react/features/chat/pages/attention-navigation.ts`；修改 `src/renderer/react/features/chat/pages/ChatPage.tsx`、`src/renderer/react/features/chat/components/ComposerSlot.tsx`、`src/renderer/react/features/chat/components/InteractionPanel.tsx`、`src/renderer/react/features/chat/components/PlanReviewPanel.tsx`、`src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/attention-navigation.test.ts src/renderer/react/features/chat/pages/ChatPage.attention-navigation.test.ts`
- [ ] C3 在 `ScheduledTaskPanel.tsx` 与 `scheduled-task-model.ts` 支持定位目标定时任务及早于最近十条的运行记录
  - 先写的测试：`src/renderer/react/features/chat/components/ScheduledTaskPanel.test.ts`：目标任务运行不在最近十条 → 可定位更早记录；任务或记录已删除时明确提示，没有重新执行任务。
  - 实现：修改 `src/renderer/react/features/chat/components/ChatPagePanelHost.tsx`、`src/renderer/react/features/chat/components/ScheduledTaskPanel.tsx`、`src/renderer/react/features/chat/components/scheduled-task-model.ts`。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/attention-navigation.test.ts src/renderer/react/features/chat/pages/ChatPage.attention-navigation.test.ts src/renderer/react/features/chat/components/ScheduledTaskPanel.test.ts`

**验收：** 本包任务 C1–C3 的全部测试通过（7 项场景，连同施工包 B 的 3 项共 10 项）；跨进程提醒定位在未就绪、多卡片、先到计划提醒、历史定时任务记录及已结算边界下均表现正确。
**回退：** 与施工包 B 成组 revert。
**工作量：** 1.5–2 人日

---

### 施工包 D：补队列入口与停止回归

依赖：无
**改动文件（只修改现有测试，扩大三模式与跨会话覆盖，不预设生产代码需要修改）：**
- `src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`
- `src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`
- `src/renderer/react/features/chat/pages/queue-actions.test.ts`
- `src/main/features/sessions/chats-pending-queue.test.ts`

**任务：**

- [ ] D1 补齐三模式忙时普通 Enter 入队、Shift+Enter 与停止按钮独立性的组件测试
  - 先写的测试：`src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`：① 三模式（Chat / Work / Code）分别在忙时普通 Enter → 入队一次；直接发送与停止均未调用；② Shift+Enter、组合输入确认、空草稿 → 不发送、不入队、不停止；③ 停止按钮点击 → 仅取消当前运行一次；未发队列和附件引用仍在。
  - 实现：在 `ChatComposer.sender-integration.test.ts` 补齐三模式与停止边界断言。
  - 验证：`npm test -- src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`
- [ ] D2 补齐跨会话队列隔离、落盘失败保留与重启认领顺序测试
  - 先写的测试：`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`、`src/renderer/react/features/chat/pages/queue-actions.test.ts`、`src/main/features/sessions/chats-pending-queue.test.ts`：① A 会话运行、切到 B 输入 → 按 B 的状态处理，A 队列不变；② 入队落盘失败 → 草稿及附件保留，不显示持久接受成功，不启动下一轮；③ 队列认领、页面刷新和重启恢复 → 原有条目顺序及稳定身份不变，未发消息不提前进入模型上下文。
  - 实现：在 `pending-queue-flow.test.ts`、`queue-actions.test.ts`、`chats-pending-queue.test.ts` 补齐跨会话与落盘失败恢复断言。
  - 验证：`npm test -- src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts src/renderer/react/features/chat/pages/pending-queue-flow.test.ts src/renderer/react/features/chat/pages/queue-actions.test.ts src/main/features/sessions/chats-pending-queue.test.ts`

**验收：** 本包任务 D1–D2 的全部测试通过（6 项场景）。
**回退：** revert 新增测试即可，无生产代码变动。
**工作量：** 0.5 人日

---

### 施工包 E：补图片用户可见反馈

依赖：施工包 A
**改动文件（非测试文件 12 个）：**

| 文件 | 改动 |
|---|---|
| 新增 `src/shared/image-delivery.ts` | 失败类型、错误码 |
| `src/main/model/vision/image-router.ts` | 集中格式能力判断 |
| `src/main/agent/runtime/build-options.ts` | 逐图失败结果、无回调分支、混合附件处理 |
| `src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/firefly-agent.ts` | 反馈回调接线及运行契约 |
| `src/main/model/providers/anthropic-adapter.ts` | 复用格式规则，保留防御性检查 |
| `src/main/agent/tools/fs-tools.ts` | 工具格式和不可用错误一致化 |
| `src/main/features/chat/agui-bridge.ts` | 发布图片反馈事件 |
| `src/renderer/react/features/chat/pages/run/AgentRunController.ts` | 按运行和附件身份归并反馈 |
| 附件展示组件及 `src/renderer/react/features/chat/pages/ChatPage.tsx` | 根据现有附件渲染入口展示失败、重试状态 |
| `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json` | 中文原因、修复建议及对应翻译 |

实施时先沿 `useComposerAttachments` 和 `ChatComposer` 的实际附件组件确定展示修改文件，不新建第二套附件界面。

#### 图片失败反馈设计

新增共享 `ImageDeliveryIssue`，仅携带运行、附件身份、阶段和稳定错误码；不携带 base64、凭据或原始服务响应。建议错误码：
- `E_IMAGE_FORMAT_UNSUPPORTED`
- `E_IMAGE_MODEL_UNSUPPORTED`
- `E_IMAGE_READ_FAILED`
- `E_IMAGE_CAPTION_UNAVAILABLE`
- `E_IMAGE_CAPTION_FAILED`

保留既有权限、授权撤销和路径拒绝错误，不把安全拒绝改写成普通读图失败。在 `image-router.ts` 增加格式能力判断，供附件预处理与厂商适配层复用。首版明确拒绝当前发送链不支持的格式（如 BMP、SVG），提示“此图片格式暂不支持，请转换为 PNG 或 JPEG 后重试”；不自动转码 SVG，不扩大文件访问权限。

新增 AG-UI 自定义事件 `firefly.image.delivery.issue`，通过现有运行事件流投递。`AgentRunController` 按运行和附件身份保存状态，界面在对应附件或运行提示区域显示中文原因。事件必须独立于模型文字，模型不回复也能看到。转述不可用、返回失败或抛异常时都进入同一反馈通道；缺少回调不得成功返回无图片、无失败标记的结果。混合附件按图片分别记录，允许支持的图片继续处理；仅含不可处理图片时停止无意义的模型调用并保留可重试材料。

**任务：**

- [ ] E1 新建 `image-delivery.ts` 并在 `image-router.ts`、`anthropic-adapter.ts`、`fs-tools.ts` 与 `build-options.ts` 统一格式判定与逐图失败结果
  - 先写的测试：`src/main/model/vision/image-router.test.ts`、`src/main/agent/runtime/build-options.test.ts`、现有 Anthropic 适配器测试、`src/main/agent/runtime/image-caption.test.ts`：① 表驱动输入协议和格式 → 支持格式保留图片块；不支持格式产生稳定错误和界面反馈，不发送对应图片字节；② 模型不支持图片 → `E_IMAGE_MODEL_UNSUPPORTED`；不调用转述服务；③ 缺回调、回调返回失败、回调抛异常 → 分别得到明确失败结果；不返回成功的空转述；④ 支持与不支持图片混合 → 成功项和失败项逐一对应，顺序稳定，没有误报其他附件失败；⑤ 授权撤销、越界或读取失败 → 保留原安全错误；拒绝后没有文件内容、base64、绝对路径或凭据泄露。
  - 实现：新建 `src/shared/image-delivery.ts`；修改 `src/main/model/vision/image-router.ts`、`src/main/agent/runtime/build-options.ts`、`src/main/model/providers/anthropic-adapter.ts`、`src/main/agent/tools/fs-tools.ts`。
  - 验证：`npm test -- src/main/model/vision/image-router.test.ts src/main/agent/runtime/build-options.test.ts src/main/agent/runtime/image-caption.test.ts src/main/agent/runtime/vendors`
- [ ] E2 在 `agent-runtime.ts`、`firefly-agent.ts`、`agui-bridge.ts`、`AgentRunController.ts` 与附件组件打通 `firefly.image.delivery.issue` 展示
  - 先写的测试：`src/main/agent/runtime/agent-runtime.test.ts`、新增 `src/renderer/react/features/chat/pages/run/image-delivery.test.ts`、对应附件组件交互测试：① 模型没有返回解释 → 用户仍看到附件失败文案；仅含不可处理图片时停止无意义的模型调用并保留可重试材料；② 切换会话、取消运行后收到迟到结果 → 不写入其他会话，不复活已取消提示。
  - 实现：修改 `src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/firefly-agent.ts`、`src/main/features/chat/agui-bridge.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.ts`、附件展示组件及 `src/renderer/react/features/chat/pages/ChatPage.tsx`、`src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`。
  - 验证：`npm test -- src/main/agent/runtime/agent-runtime.test.ts src/renderer/react/features/chat/pages/run/image-delivery.test.ts`；`npm run check:renderer`

**验收：** 本包任务 E1–E2 的全部测试通过（7 项场景）；图片不可发或转述失败时界面直接显示准确中文原因且无敏感数据泄露。
**回退：** revert 本包提交；退回原有模型上下文占位提示。
**工作量：** 2–3 人日

---

### 施工包 F：统一计划只读策略

依赖：无
**改动文件：**
- 新增 `src/main/agent/runtime/plan-tool-policy.ts`、`src/main/agent/runtime/plan-tool-policy.test.ts`。
- 修改 `src/main/agent/runtime/adapter/tool-runtime.ts`、`src/main/agent/runtime/adapter/tool-runtime.test.ts`、`src/main/agent/loop/tool-dispatcher.ts`、新增 `src/main/agent/loop/tool-dispatcher.plan-policy.test.ts`：共用策略并覆盖执行前复核。
- 按现有工具结果传播链修改 `src/main/agent/loop/types.ts`、`src/main/agent/runtime/adapter/event-mapper.ts`，保留稳定错误码。
- 扩展 `src/main/agent/loop/plan-tools.test.ts`、`src/main/agent/tools/builtin-tools/run-shell-plan-boundary.test.ts`。
- 用 `git grep -n` 盘点内置工具、MCP、插件注册中的 `effectKind`、`effectResolver`；仅修正已核实的读取声明。声明未知的外部工具保持拒绝，不批量标为 read。

#### 计划阶段只放行明确读取设计

新增主进程纯策略模块 `plan-tool-policy.ts`，统一检查：
- `PLAN_DISCUSSING`、`PLAN_REVIEW` 使用 `resolveEffectKind(definition, args)`。
- 只有结果为 `"read"` 才能继续进入原有三档权限（`read-only` / `per-action` / `full`）检查。
- 缺声明、未知值、解析异常、`mutation`、`verification`、`external_side_effect` 均拒绝。
- `run_shell` 保留现有禁止规则，不通过命令字符串分类放行。
- 计划限制先于完全访问（`full` / `allow_all`）；读取工具仍受原有目录、网络、会话权限和取消限制。

同一策略用于初次权限检查、审批返回后的检查、执行协调等待结束后的复核，以及调度器无回调时的兜底。伙伴执行使用父会话实时计划状态。沿用 `category: "permission_denied"`，新增稳定错误码 `E_PLAN_READ_ONLY`，中文提示“计划讨论期间仅允许读取信息，请先批准计划再执行此操作”。通过现有工具结果及错误传播链展示，不仅写控制台日志。Harness 控制工具单独核对：进入计划、受限计划文件写入、用户澄清和审批状态流继续走现有专用路径；普通写入工具不能借此获得豁免。委派和其他 builtin 必须验证不会绕过父会话限制。

**任务：**

- [ ] F1 实现 `plan-tool-policy.ts` 纯策略并核实内置读取工具的 `effectKind` 声明
  - 先写的测试：`src/main/agent/runtime/plan-tool-policy.test.ts`：① 三模式 × 两种计划只读状态（`PLAN_DISCUSSING` / `PLAN_REVIEW`）× 三档权限（`read-only` / `per-action` / `full`）× 各 effect → 仅 `"read"` 进入原权限检查；其他结果为 `E_PLAN_READ_ONLY`、`permission_denied`；② `risk: "safe"` 但 effect 为 `mutation`，或 effect 缺失 → 拒绝；无审批弹窗、execute、写文件或外部调用；③ 参数解析器对不同输入返回不同 effect → 按本次参数判断；解析器异常时拒绝。
  - 实现：新建 `src/main/agent/runtime/plan-tool-policy.ts`；盘点并仅修正已核实的内置读取工具 `effectKind`。
  - 验证：`npm test -- src/main/agent/runtime/plan-tool-policy.test.ts`
- [ ] F2 接入 `tool-runtime.ts`、`tool-dispatcher.ts` 与错误传播链，验证等待期进入计划状态、伙伴继承与控制工具边界
  - 先写的测试：`src/main/agent/runtime/adapter/tool-runtime.test.ts`、`src/main/agent/loop/tool-dispatcher.plan-policy.test.ts`、`src/main/agent/loop/plan-tools.test.ts`、`src/main/agent/tools/builtin-tools/run-shell-plan-boundary.test.ts`：① 原权限拒绝读取 → 仍拒绝，不因 effect 为 read 获得权限；② 审批或执行锁等待期间进入计划状态 → 实际执行前拒绝，断言执行次数为零；③ 伙伴报告 Work 模式、父会话处于计划讨论 → 同样拒绝副作用；④ `write_plan`、用户澄清、批准执行完整流程 → 保持原状态流；普通写入不能借用控制工具权限；⑤ 批准后进入 `EXECUTING` → 恢复原权限判断，不自动扩大全局权限。
  - 实现：修改 `src/main/agent/runtime/adapter/tool-runtime.ts`、`src/main/agent/loop/tool-dispatcher.ts`、`src/main/agent/loop/types.ts`、`src/main/agent/runtime/adapter/event-mapper.ts`。
  - 验证：`npm test -- src/main/agent/runtime/plan-tool-policy.test.ts src/main/agent/runtime/adapter/tool-runtime.test.ts src/main/agent/loop/tool-dispatcher.plan-policy.test.ts src/main/agent/loop/plan-tools.test.ts src/main/agent/tools/builtin-tools/run-shell-plan-boundary.test.ts`

**验收：** 本包任务 F1–F2 的全部测试通过（8 项场景）；计划讨论期间一切非明确 `"read"` 的普通工具均以 `E_PLAN_READ_ONLY` 拒绝且零执行副作用。
**回退：** revert 本包提交；退回原有基于 `risk` 的计划阶段判断。
**工作量：** 1.5–2 人日

---

### 施工包 G：压缩刷新回归与拒绝提示

依赖：无
**改动文件：**
- `src/main/features/sessions/chats-ipc.test.ts`：补成功快照、广播及拒绝无写入。
- 新增 `src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts`：验证广播到页面显示。
- `src/renderer/react/features/chat/components/ContextUsageRing.tsx`、`src/renderer/react/features/chat/components/SlashCommandMenu.tsx`：统一不支持压缩的中文反馈。
- `src/renderer/react/features/chat/components/ContextUsageRing.test.ts`、`src/renderer/react/features/chat/components/SlashCommandMenu.test.ts` 及 `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`。
- 不重写已有快照和广播实现。

**任务：**

- [ ] G1 补齐手动压缩成功快照与页面即时刷新回归测试
  - 先写的测试：`src/main/features/sessions/chats-ipc.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts`：① 支持会话压缩成功 → 精确断言新快照、持久化结果和广播接收者；包含发起窗口；② 页面收到广播 → 无下一轮运行、无切会话操作即可显示新 token、分类和比例；③ 压缩期间用户切到其他会话 → 只更新所属会话缓存，不覆盖当前显示。
  - 实现：扩充 `chats-ipc.test.ts` 并新建 `ChatPage.context-usage.test.ts`。
  - 验证：`npm test -- src/main/features/sessions/chats-ipc.test.ts src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts`
- [ ] G2 统一 `ContextUsageRing.tsx` 与 `SlashCommandMenu.tsx` 对 `MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED` 及压缩失败的提示
  - 先写的测试：`src/renderer/react/features/chat/components/ContextUsageRing.test.ts`、`src/renderer/react/features/chat/components/SlashCommandMenu.test.ts`：① 记忆运行时拥有会话 → 返回 `MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED`，显示“当前会话暂不支持手动压缩”；无摘要模型调用、历史替换、快照写入和成功提示；② 摘要失败、短会话或重复压缩 → 原历史和快照不变，环形图与 `/compact` 错误反馈一致。
  - 实现：修改 `src/renderer/react/features/chat/components/ContextUsageRing.tsx`、`src/renderer/react/features/chat/components/SlashCommandMenu.tsx`、`src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`。
  - 验证：`npm test -- src/main/features/sessions/chats-ipc.test.ts src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts src/renderer/react/features/chat/components/ContextUsageRing.test.ts src/renderer/react/features/chat/components/SlashCommandMenu.test.ts`

**验收：** 本包任务 G1–G2 的全部测试通过（5 项场景）。
**回退：** revert 本包提交。
**工作量：** 0.5–1 人日

---

### 施工包 H：三模式性能基线与条件性修复

依赖：无
**改动文件：**
- 修改 `src/renderer/react-perf/fixture.ts`、`src/renderer/react-perf/fake-bridges.ts`、`src/renderer/react-perf/main.tsx`：支持模式参数及实际消息类型。
- 修改 `scripts/perf/chat-renderer-baseline.mjs`：沿用现有测量流程传递模式。
- 修改 `src/renderer/react-perf/fixture.test.ts`、`src/renderer/react/features/chat/components/ChatMessageList.test.ts`：覆盖模式和缓存失效边界。
- 必要时扩展 `chat-perf-probe.ts`，只在性能入口启用。
- 只有测量定位后，才局部修改 `ChatPage.tsx`、`ChatMessageList.tsx`、导航或侧栏；达标即停止，虚拟化、分页、渲染器迁移不作为默认施工项。

#### 性能基线与缓存边界设计

先扩展现有 fixture 和运行脚本支持三模式，保留固定 seed、数据集、规模及滚动位置。记录历史渲染次数、导航和侧栏渲染次数、commit P95、事件到绘制 P95、DOM、heap。预热及合法业务变化之外，稳定历史消息不应因流式增量重新派生或渲染；导航和侧栏 props 未变时不应随 token 更新。性能数值门槛由负责人批准，不修改 CI 阈值。未找到失效链时只交付测量结果和回归测试，不修改生产渲染代码。

**任务：**

- [ ] H1 扩展 `react-perf` 与 `chat-renderer-baseline.mjs` 支持三模式并补齐 `ChatMessageList.test.ts` 缓存失效边界
  - 先写的测试：`src/renderer/react-perf/fixture.test.ts`、`src/renderer/react/features/chat/components/ChatMessageList.test.ts`：① 只更新流式消息 → 历史条目身份不变、完整条目顺序不变；② 工具、推理、伙伴结果、图片、计划和代码消息变化 → 只使相关派生结果失效，内容不陈旧；③ 表情配置、语言或角色展示配置变化 → 应变化的内容刷新，缓存不能隐藏变化；④ 切换会话、删除消息、卸载 → 不复用其他会话内容，不留下持续增长的强引用；⑤ 固定数据、同构建参数重复测量 → 输出逐配置指标及中位数；不得用单次截图代替性能结果。
  - 实现：修改 `src/renderer/react-perf/fixture.ts`、`src/renderer/react-perf/fake-bridges.ts`、`src/renderer/react-perf/main.tsx`、`scripts/perf/chat-renderer-baseline.mjs`；若测量发现具体失效链则做最小局部修复。
  - 验证：`npm test -- src/renderer/react-perf src/renderer/react/features/chat/components/ChatMessageList.test.ts`；`npm run perf:chat-baseline -- --smoke`

**验收：** 本包任务 H1 的全部测试通过（5 项场景）；三模式性能基线可复现采集并输出中位数。
**回退：** 性能改动优先回退局部生产优化，保留测量入口。
**工作量：** 1–2 人日

---

### 施工包 I：设置搜索弹窗与可靠定位

依赖：无
**改动文件（非测试文件 11 个）：**

| 文件 | 改动 |
|---|---|
| `src/renderer/settings/index.html` | 标题栏入口、弹窗及稳定目标标记 `data-settings-search-id` |
| `src/renderer/settings/shared/search.ts` | 复用匹配，改为稳定目标索引 |
| 新增 `src/renderer/settings/shared/search-target.ts` | 可取消异步定位状态机 |
| 新增 `src/renderer/settings/shared/search-dialog.ts` | 弹窗、键盘、焦点管理 |
| `src/renderer/settings/settings.ts` | 装配，切页、语言变化和外部导航取消 |
| `src/renderer/settings/api/agent-routing.ts`、`src/renderer/settings/usage/panel.ts`、`src/renderer/settings/search/panel.ts` | 动态条目和加载、条件状态适配 |
| `src/renderer/settings/settings-system.css` | 弹窗和目标行高亮，保留减少动态效果支持 |
| 设置侧两份 i18n JSON | 等待、不可用、超时文案 |
| `src/renderer/settings/shared/search.test.ts`、新增 `search-target.test.ts`、新增 `search-dialog.test.ts`、`src/renderer/settings/settings-i18n-regression.test.ts` | 搜索及异步交互断言 |

#### 设置搜索设计

保留原生设置页及 `searchEntries` 的多词匹配逻辑，将搜索入口移到标题栏弹窗。首版不增加搜索历史和分类浏览。将搜索条目从长期持有 DOM 元素改为稳定目标：
- `id`、`section`、当前语言名称与说明。
- 条件可用性、可选的只影响界面展示的展开动作。
- 目标元素按定位时重新解析。
- 动态条目只索引公开名称和说明，不索引输入框值、密钥、地址或配置正文。

拟新增 `data-settings-search-id` 作为定位标记。静态描述与动态条目共用索引契约；语言变化重新生成文案，不跨语言混用索引。面板加载状态明确为 `loading / ready / error`：
- 有加载声明：ready 后立即查找；loading 超过三秒显示等待状态，最多等待三十秒。
- 无加载声明：三秒兜底。
- ready 后目标缺失、条件不满足或加载失败：提示不可用，不高亮页面标题冒充定位成功。
- 新选择、关闭弹窗、外部 IPC 切页或卸载时取消旧定位，清理观察器和定时器。
- 折叠区域可以展开；不切换功能开关、不保存配置、不自动启用服务。

新增设置侧 i18n 文案：“正在定位设置项…”“此设置项当前不可用”“设置项加载超时，请重试”。弹窗支持键盘选择、Escape、焦点恢复和减少动态效果；定位只高亮目标行。

**任务：**

- [ ] I1 改造 `search.ts` 为稳定目标索引并适配动态面板条目与条件可见性
  - 先写的测试：`src/renderer/settings/shared/search.test.ts`：① 中文名称输入多个关键词 → 比较完整有序结果；切换语言后按当前语言重新搜索；② 条件关闭、`display:none`、祖先隐藏或读取状态失败 → 不显示虚假可定位项；不自动开启开关或调用保存；③ 索引、搜索结果和日志 → 不含输入值、密钥和配置正文。
  - 实现：修改 `src/renderer/settings/index.html`、`src/renderer/settings/shared/search.ts`、`src/renderer/settings/api/agent-routing.ts`、`src/renderer/settings/usage/panel.ts`、`src/renderer/settings/search/panel.ts`。
  - 验证：`npm test -- src/renderer/settings/shared/search.test.ts`
- [ ] I2 实现 `search-target.ts` 异步定位状态机与 `search-dialog.ts` 标题栏弹窗交互
  - 先写的测试：`src/renderer/settings/shared/search-target.test.ts`、`src/renderer/settings/shared/search-dialog.test.ts`、`src/renderer/settings/settings-i18n-regression.test.ts`：① 面板未加载时选择目标 → ready 前不滚动；ready 后只高亮实际目标行一次；② 声明 loading 的面板在三秒仍未完成（假定时器） → 保持观察并提示等待；三十秒超时后清理资源；③ 面板 ready 但无目标 → 立即提示不可用，不高亮页面标题；④ 关闭弹窗、外部切页、重新选择及卸载 → 旧请求结果无效，观察器和定时器清零；⑤ 键盘、鼠标交替选择 → 只有一个活动项；Escape 和关闭后焦点正确恢复。
  - 实现：新建 `src/renderer/settings/shared/search-target.ts`、`src/renderer/settings/shared/search-dialog.ts`；修改 `src/renderer/settings/settings.ts`、`src/renderer/settings/settings-system.css` 及设置侧两份 i18n JSON。
  - 验证：`npm test -- src/renderer/settings/shared src/renderer/settings/settings-i18n-regression.test.ts src/renderer/settings/i18n`

**验收：** 本包任务 I1–I2 的全部测试通过（8 项场景）；标题栏搜索弹窗与异步面板可靠定位符合契约。
**回退：** revert 本包提交；恢复原侧栏搜索入口。
**工作量：** 2–3 人日

## 验收清单（全量）

以下为实施时命令，本次计划编写未运行。命令均基于当前 `package.json`；新增测试文件须先创建才能执行。每步再补运行实际修改模块的既有测试，使用 `npm test --` 保留仓库现有测试报告归档入口，不另建测试运行器。

- [ ] 各施工包最近测试全部通过：
  ```powershell
  # 施工包 A
  npm test -- src/main/base/identity/runtime-profile.test.ts src/main/app/identity-preflight.test.ts src/main/base/storage/storage-context.test.ts

  # 施工包 B & C
  npm test -- src/main/toast src/main/platform/windows/window-activation.test.ts src/main/platform/windows/react-chat-session-dispatcher.test.ts src/main/features/sessions/chat-ui-ipc.test.ts
  npm test -- src/renderer/react/features/chat/pages/attention-navigation.test.ts src/renderer/react/features/chat/pages/ChatPage.attention-navigation.test.ts src/renderer/react/features/chat/components/ScheduledTaskPanel.test.ts

  # 施工包 D
  npm test -- src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts src/renderer/react/features/chat/pages/pending-queue-flow.test.ts src/renderer/react/features/chat/pages/queue-actions.test.ts src/main/features/sessions/chats-pending-queue.test.ts

  # 施工包 E
  npm test -- src/main/model/vision/image-router.test.ts src/main/agent/runtime/build-options.test.ts src/main/agent/runtime/agent-runtime.test.ts src/main/agent/runtime/image-caption.test.ts src/main/agent/runtime/vendors
  npm test -- src/renderer/react/features/chat/pages/run/image-delivery.test.ts

  # 施工包 F
  npm test -- src/main/agent/runtime/plan-tool-policy.test.ts src/main/agent/runtime/adapter/tool-runtime.test.ts src/main/agent/loop/tool-dispatcher.plan-policy.test.ts src/main/agent/loop/plan-tools.test.ts src/main/agent/tools/builtin-tools/run-shell-plan-boundary.test.ts

  # 施工包 G
  npm test -- src/main/features/sessions/chats-ipc.test.ts src/renderer/react/features/chat/pages/ChatPage.context-usage.test.ts src/renderer/react/features/chat/components/ContextUsageRing.test.ts src/renderer/react/features/chat/components/SlashCommandMenu.test.ts

  # 施工包 H
  npm test -- src/renderer/react-perf src/renderer/react/features/chat/components/ChatMessageList.test.ts

  # 施工包 I
  npm test -- src/renderer/settings/shared src/renderer/settings/settings-i18n-regression.test.ts src/renderer/settings/i18n
  ```
- [ ] 类型、构建与整体回归全部通过：
  ```powershell
  npm run check:storage-boundary
  npm run build:main
  npm run build:preload
  npm run check:renderer
  npm run build:renderer
  git diff --check
  npm test
  npm run build
  ```
- [ ] 性能验证（基线与候选使用同一设备、电源状态、构建类型、seed、数据集和滚动位置；交替运行，报告逐轮结果及中位数）：
  ```powershell
  npm run perf:chat-baseline -- --smoke
  npm run perf:chat-baseline -- --runs 1 --only-b
  npm run perf:chat-baseline
  ```
- [ ] Electron 真机验收（在实施验证环境创建专用空隔离根，设置 `FIREFLY_ISOLATION_ROOT` 后运行 `npm run dev`；先确认启动日志的所有数据路径归属，再操作；不得启动 1.1.x 数据目录进行比较；平台、服务或依赖缺失的项目记录为未验证，自动化测试不得静默跳过）：
  1. 三模式分别运行可控任务，最小化或关闭聊天窗口；触发审批、选择、抽查、计划审批，点击 Toast 检查会话、模式和具体交互。
  2. 多个会话同时等待输入，连续点击不同提醒；确认最后请求生效，无错误批准或作答。
  3. 触发定时任务，点击完成提醒；确认任务及对应运行记录展开。
  4. 双显示器、缩放不同、聊天窗口销毁后检查 Toast 位置、裁切和焦点。
  5. 三模式流式期间普通 Enter 入队、Shift+Enter 换行、中文输入法确认、点击停止；检查队列保留和消费顺序。
  6. 发送支持与不支持格式、不可读文件及分析失败图片；检查模型无解释时仍有中文提示。
  7. 支持压缩的测试会话检查即时刷新；当前记忆会话检查明确拒绝且历史不变。
  8. 设置搜索切换语言、进入异步面板、隐藏条件项、关闭后等待迟到响应；检查定位和取消。
  9. 重启应用，确认只加载本次 1.2.0 隔离数据。

## 回滚方案

- **数据隔离遗漏：** 正式配置当前仍使用旧目录。新目录切换必须先于正式运行验收；失败时停止启动，不回退旧数据。
- **提醒身份不完整：** 事件缺少会话归属时不能准确定位。允许窗口级提示兜底，并明确记录未具备精确落点的来源；不猜当前会话。
- **定位竞争：** 卡片结算、页面重载和连续点击可能交错。请求代次、ready 缓存和取消机制必须同批交付。
- **格式拒绝影响体验：** BMP、SVG 可能从“尝试发送”变为明确拒绝。保留附件和修复提示，不自动执行转码。
- **effect 声明不实：** `effectKind: "read"` 是声明，不能替代实现审计及原权限边界。误标只修具体工具，不放宽全局规则。
- **默认记忆会话不支持旧压缩：** 本主题只改善反馈与成功刷新验收，不能声称所有新会话均可手动压缩。
- **性能指标波动：** 先留当前基线，再测候选；未定位到生产瓶颈时停止修改，不用提高阈值消除失败。
- **设置索引漂移：** 稳定标识与面板加载状态一同维护；目标缺失明确失败，不定位到相邻项。

代码按独立施工包回退，跨进程契约的生产方与消费方（施工包 B 与 C）成组回退。性能改动优先回退局部生产优化，保留测量入口。数据回退仅在 1.2.0 自身数据范围内进行，不迁移到 1.1.x；应用版本回退不得共用两代目录。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

已采纳并写入全局约束与对应施工包的结论：
- 1.2.0 正式目录名称及主题归属：使用 `%APPDATA%\Firefly-1.2.0`；由统一数据隔离主题交付，本计划负责验收接入（施工包 A）。
- 定时任务提醒落点：使用现有聊天窗口任务面板，定位任务和具体运行记录；不新增独立窗口（施工包 B/C）。
- 等待审批或提问期间是否同时允许编辑排队消息：首版保留交互面板优先；普通流式运行继续允许排队，同时展示输入框另行设计（施工包 D）。
- BMP、SVG 等格式处理：首版明确拒绝并提示转换；自动转码另行评估（施工包 E）。
- 默认记忆会话是否必须支持手动压缩：本主题保留现有保护并显示明确原因；若要求启用，另立记忆运行时压缩契约，不能复用旧历史改写路径（施工包 G）。
- 设置搜索是否同时增加历史和多层分类：首版只做标题栏弹窗、搜索和可靠定位；历史、分类及额外动画单独排期（施工包 I）。
- 性能数值验收线：先在目标设备记录基线，再批准 P95、heap 等预算；历史稳定消息零重复渲染作为行为要求，不改 CI 阈值（施工包 H）。

仍真正未决的项：无（目标设备性能基线采集后的具体 P95 / heap 数字预算在施工包 H 测量后由负责人签字确认）。

## 工作量

按一名熟悉 Firefly 的工程师估算，含定向测试和局部修复：

| 施工包 | 工作量 |
|---|---:|
| 施工包 A：数据目录接入及隔离回归 | 0.5–1 人日 |
| 施工包 B：提醒身份与窗口激活分发 | 1.5–2 人日 |
| 施工包 C：跨进程就绪缓冲与渲染端精确落点 | 1.5–2 人日 |
| 施工包 D：队列三模式回归 | 0.5 人日 |
| 施工包 E：图片格式和用户可见反馈 | 2–3 人日 |
| 施工包 F：计划 effect 策略及执行前复核 | 1.5–2 人日 |
| 施工包 G：压缩刷新回归与拒绝提示 | 0.5–1 人日 |
| 施工包 H：三模式性能测量及有证据的局部修复 | 1–2 人日 |
| 施工包 I：设置搜索弹窗及异步定位 | 2–3 人日 |
| 整体回归、真机验收与问题修复 | 1–1.5 人日 |
| **合计** | **12–18 人日** |

估算不包含新的记忆压缩机制、自动图片转码、独立任务窗口、搜索历史、分类浏览、消息虚拟化或渲染器迁移。若定向回归证明队列或压缩存在新的生产缺陷，先记录复现和影响，再调整对应施工包工作量。
