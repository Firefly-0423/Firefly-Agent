# Firefly-Agent 1.2.0 ChatPage 回归清单施工计划
状态：待施工
规格：无独立规格；沿用本计划已确认回归范围及负责人决定；权限档位按 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2，施工结构按 `docs/contributing/development-workflow.md` §3–5。

**目标：** 建立一份以 Firefly 实际行为为准、可以重复执行并留下证据的 ChatPage 回归清单。覆盖 Chat、Work、Code 中适用的流式回答、工具过程、取消、终态持久化、恢复与接管、消息队列、交互卡、会话管理、附件、语音输入、待办和上下文状态。

本次施工以**补齐测试和交互验收证据**为主，不重写已有功能。已有源码或测试只能证明存在相应实现、测试场景，不能直接标记为交互验收通过。只有回归发现并复现缺陷后，才在所属模块安排最小修复。

**架构：** React 页面组织界面，preload 承担受控 IPC，主进程负责运行守卫、审批与持久化。组合测试保留实际 ChatPage、队列与控制器，以可预测替身隔离模型、网络和系统服务；存储使用真实临时文件和模块重载，真机另验刷新、重启和跨会话操作。

## 现状

以下保留原盘点证据，不把源码阅读当作执行通过。原盘点基线与范围如下；其中工作树状态、“本次”及“当前”均指原盘点时点，不代表此次改写时的状态：

- 只读核对基线：`c991111efa68087b9d625868179c03fea1b83e14`。
- 当前工作树干净，处于 detached HEAD；本地 `dev/firefly-1.2.0` 已指向 `c9920cfc62bcd1177f24a295b9d8b5f8888ab688`。本计划不包含后一提交的差异，实施前必须重新核对。
- 已完整读取 `AGENTS.md`，按其“修改与验证”“测试断言写法”制定测试。
- 模块边界依据 `README.md:213–218` 的目录职责表：React 页面组织界面，preload 承担受控 IPC，主进程负责运行守卫、审批与持久化。
- 外部参考文档仅用于提取回归主题；未读取其链接的设计文档或任何代码。
- 本次仅形成计划正文，未创建文件、修改仓库、执行 Git 写操作，也未运行测试、构建或应用。下文命令均供后续施工使用。
- 不读取、复制或迁移 1.1.x 用户数据；所有验收从全新的 1.2.0 测试目录开始。不新增检查工具，不调整 CI、超时或覆盖率阈值。

下表中的“已有测试”均表示已阅读测试源码，**不表示本次执行通过**。

| 领域 | Firefly 已有实现及证据 | 施工范围 |
| --- | --- | --- |
| 三种模式 | `src/shared/chat-types.ts:8` 的 `ConversationMode` 仅含 `chat`、`work`、`code`。 | 按三模式建立矩阵，不增加模式。 |
| 流式回答与工具过程 | `pages/run/AgentRunController.ts` 的 `handleEvent`、`buildCheckpoint` 处理 reasoning、正文、候选文本、工具和检查点；同目录测试已有候选文本、过程顺序、正式回答提交及外来事件隔离场景。 | 不重做流式实现；补三模式组合和页面衔接验证。 |
| 正式回答与终态 | 控制器 `start` 在正式回答满足提交条件后写入终态，再刷新主进程的 `sSettlement` 并调用 `reportRunPersisted`；`AgentRunController.test.ts:202–275`、`:365` 已覆盖部分场景。 | 补真实文件重载及故障边界，不能只检查 mock 收到保存调用。 |
| 取消 | `AgentRunController.test.ts:127` 已有 ack 前取消；`:235` 已有部分正文后取消；`pages/cancel-run.ts` 是页面取消入口。 | 不新增取消协议；补停止按钮、队列衔接及迟到事件验证。 |
| 守卫与接管 | `src/main/chat/agui-bridge.ts:398–402` 已有 `SESSION_RUN_ACTIVE:<runId>`、`SESSION_RUN_TAKEOVER_STUCK:<runId>`；对应测试覆盖并发、接管等待、陈旧取消。控制器测试 `:277–337` 覆盖接管卡和合法 owner 保留。 | 不重写守卫；补刷新后页面接管和跨会话验收。 |
| 恢复 | `ChatPage.tsx:426–440` 仅对非 Chat 查询中断任务；`session-runtime-state.ts` 的 `recoverInterruptedMessage` 会停止未完成检查点的动画。已持久化终态不会统一改写为中断。 | 区分“已结束后重开”与“运行中崩溃后重开”，分别验收。 |
| 待发队列 | `ChatPage.tsx:859–898` 的发送统一经过主进程权威队列，入队成功后才清发送快照；`pending-queue-flow.ts` 实现认领、恢复、串行消费和暂停。`src/main/chats/chats-pending-queue.test.ts` 已有 FIFO、幂等、真实落盘重启和写失败测试。 | 不另建页面队列；补页面、控制器、存储之间的组合测试。 |
| 审批与选择卡 | `interaction-events.ts` 订阅请求和结算；`interaction-resolution.ts` 区分 `ok:false` 与传输异常；`session-runtime-state.test.ts:57–111` 已有去重、排队及跨会话清卡测试。 | 补真实页面操作与取消结算的衔接。 |
| 审批归属差异 | `interaction-owner.ts` 的 `interactionOwner` 在找不到 run owner 时回退可见会话；`ChatPage.tsx:252–260` 使用该结果投递卡片。 | 已定：已携带但无法归属的 run 不回退当前会话；施工包 G 单列修复及测试，无 run ID 的合法请求另定规则。 |
| 计划 | `ChatPage.tsx:443–495` 持久监听审阅、批准、补充事件；`plan-review-state.ts` 绑定批准尝试、助手消息、执行 run 和计划路径；`ChatPage.plan-lifecycle.test.ts` 已有迟到、重复、失败及后台完成场景。 | 不重建计划状态机；补缺少的批准次数和页面呈现验证。 |
| 计划模式差异 | `conversation-run-policy.ts` 对 Chat、Code 开启延后计划事件监听，Work 关闭；`ChatPage.tsx` 的 `activePlan` 只在 Code 提供面板内容。控制器 `handleEvent` 校验完成事件的 `threadId`、`runId`、`planPath`、`runStatus`。 | 不采用“缺少会话身份就完成当前计划”的规则；完整计划交互先以 Code 验收；Chat 的监听与可见面板差异另定产品行为。 |
| 桌面语音 | `ChatComposer.tsx:472` 将转写追加到草稿；`DesktopAsrButton.tsx` 和 `desktop-asr-controller.ts` 管理录音、取消及迟到结果。中文 `dictation.hint` 明确“不自动发送”。 | 将“语音外部自动提交”替换为现有桌面听写回归，不建设后台语音自动派发。 |
| 语音历史痕迹 | `ChatPage.tsx:900` 附近仍有外部提交说明注释，但其后直接进入 `cancelCurrentRun`，注释不足以证明存在提交入口。 | 不据此虚构 IPC、回执错误码或后台会话提交能力。 |
| 附件 | `hooks/useComposerAttachments.ts` 接收导入返回的图片和文档；处理粘贴、截图、caption/direct 策略、删除及发送快照清理。同名测试已有主要流程。 | 不增加“仅允许图片”限制；补边界、异步切换和页面发送验证。 |
| 会话管理 | `openSessionByDeps.ts`、`use-session-scope.ts`、`session-actions.ts` 负责打开、代次隔离和管理；`openSessionByDeps.race.test.ts` 已覆盖陈旧打开请求。 | 不重建会话管理；补页面列表、草稿、模型与工作区的组合验收。 |
| 编辑与重生成 | `use-last-turn-actions.ts` 限制 Chat、空闲状态和单次 revision；`last-turn-revision.ts` 重新读取存储并调用 `replaceTail`，通过 `transcriptRewind` 重启。 | 保持仅 Chat 可用，补入口禁用和存储失败不派发。 |
| Todo 与上下文 | 控制器处理 `firefly.todo`、`firefly.context.usage`、`firefly.compressingContext`；`session-runtime-state.ts` 过滤旧 run Todo；`session-snapshot.ts` 恢复快照。`ChatPage.tsx:947–963` 构造步骤胶囊和上下文展示值。 | 验证实际组件，不另建独立 Todo 面板。Code 另验 `CodeGitPanel` 的 Todo 呈现。 |
| TTS | `ChatMessageList.tsx`、`src/shared/chat-types.ts` 保留缓存字段，中文资源保留 TTS 文案；在已检查的页面控制器、preload、IPC 常量及主进程装配中未找到完整播放链路。 | 不将字段存在算作可播放。已定：本主题暂不承诺正向播放验收；若要求交付，先明确已有入口或单列实现计划。 |
| 数据隔离 | `src/main/startup/runtime-profile.ts` 支持独立 development/test/smoke 档案；production 仍定位 `%APPDATA%\Firefly`。`scripts/dev/launch-electron.mjs` 支持 `FIREFLY_ISOLATION_ROOT`。 | 测试隔离能力复用；1.2.0 正式新目录是发布前置条件，不能宣称当前已满足。 |

上述页面文件均位于 `src/renderer/react/features/chat/pages/`，组件位于同一 feature 的 `components/`，附件 Hook 位于 `hooks/`。

**不改的东西：** 不重写已有流式实现、取消协议、运行守卫、页面队列、计划状态机或会话管理；不新增模式、IPC、错误码、产品存储字段或数据库版本。Chat 编辑和重生成仅空闲最后一轮可用；附件保持实际支持的图片和文档；听写填草稿、用户主动发送；Todo 与上下文不增加第二份权威状态。施工包 G 单列已批准的审批归属收紧；其余已复现缺陷单列最小修复。

## 全局约束

- 只以 Firefly 当前仓库为产品源码基线；外部参考文档只提取回归主题，不复制其代码，不在运行、构建、测试或打包时读取外部工作树。
- 采用届时 `dev/firefly-1.2.0` 确认的提交，先补齐相对 `c991111` 的差异盘点。原证据保留，不声称其历史行号已在新基线上重新逐项验证。
- 不扫描、读取、复制、回退或迁移 1.1.x 数据，fixture 和验收目录全新创建。
- 正式数据目录已定 `%APPDATA%\Firefly-1.2.0`，由启动与存储主题落实，是正式包验收前置条件；本主题复用隔离能力。
- 用户权限仅三档：只读 `read-only`、请求审批 `per-action`、完全访问 `full`。1.2.0 删除旧值 `project-read-only` 和 `scoped`；本主题不自行改权限策略，不按五档做矩阵。
- 不新增运行时依赖或检查工具，不调整 CI、超时、覆盖率阈值；沿用现有质量要求。
- 每个任务先写失败测试，再补缺项；已有等价测试直接复用；失败不弱化断言。每包一个 PR，测试和实现同包，独立验证、独立回退，不依赖后包修复才能通过。
- 以下产品施工命令供后续执行。

### 通用断言要求（同时遵守 AGENTS.md 全部 12 条）

- 同一契约按三模式或终态表驱动，输入和预期直接可读。
- 对稳定结果比较完整消息、卡片、队列或有序列表；非本契约字段才使用部分匹配。
- 固定时钟和 ID；定时器结束后恢复。
- 网络、模型、ASR、截图和系统权限使用可控替身。
- 持久化测试在独立临时目录中创建真实文件，结束后清理；不使用任何用户历史 fixture。
- 失败场景同时断言禁止的调用、写入、正式回答提交和跨会话更新均未发生。
- 平台或服务缺失时显式标记跳过及原因，不能静默返回或计为通过。

### 设计细节 1：回归记录结构

后续新增回归文档，每条记录包含：

| 字段 | 内容 |
| --- | --- |
| 用例编号 | 固定编号，关联施工步骤及测试名称 |
| 模式 | Chat / Work / Code，或明确不适用及原因 |
| 前置状态 | 会话、运行、队列、审批、工作区和服务状态 |
| 操作或事件输入 | 可重复的用户操作或替身事件序列 |
| 可观察结果 | 文案、消息、卡片、面板、持久化内容 |
| 禁止副作用 | 重复派发、越会话更新、错误提交、意外写入等 |
| 自动化证据 | 测试路径、名称、命令、报告 |
| 真机证据 | 提交、环境、执行人、日期、脱敏截图或录屏 |
| 结果 | 未执行 / 通过 / 失败 / 阻塞 / 不适用 |

该结构只用于测试和文档，不增加产品存储字段或数据库版本。

### 设计细节 2：复用现有数据与状态流转

保持以下产品契约：

1. `ChatMessage.runSnapshot` 保存 `running`、`waiting_user`、`interrupted`、`terminal`；`terminalStatus` 区分 `success`、`cancelled`、`timeout`、`runtime_error`。
2. `ChatMessage.sSettlement` 保留主进程权威回答结算信息；页面缓存不能单独证明正式回答成功。
3. `ChatSession.pendingMessages` 与 `pendingDispatch` 继续承担持久待发与认领恢复；页面只投影主进程结果。
4. `SessionInteractionState` 按会话保存交互卡；卡身份包含种类与 ID。
5. `PlanReviewBySession` 沿用 `plan-review-state.ts` 的身份绑定，不以“当前显示会话”代替执行身份。
6. Todo 与上下文沿用现有会话状态和消息快照，不增加第二份权威状态。

重点验证的流转：

- 发送 → 入队确认 → 清理发送快照 → 认领 → run ack → 流式过程 → 终态持久化 → 运行清理 → 后继消费。
- 入队失败 → 保留草稿及附件，不派发。
- ack 前取消 → ack 后定向取消，不留下孤儿运行。
- 已接受运行结束 → 按现有策略消费后继；派发被拒绝或 `queuePaused:true` → 保留恢复入口，不循环重试。
- 已保存终态重开 → 保持对应终态；未完成检查点重开 → 停止动画并显示中断，不自动证明或重放外部副作用。

依据：`AgentRunController.start/buildCheckpoint/writeCheckpoint`、`createPendingQueueFlow`、`recoverInterruptedMessage`、`evaluateClaimRecovery`。

### 设计细节 3：IPC 与错误码

本主题不增加 IPC 或错误码，沿用：

| 领域 | 现有契约 |
| --- | --- |
| 运行 | `agui:run`、`agui:event`、`agui:cancel`、`agui:run-persisted` |
| 恢复 | `harness:get-interrupted-run`，请求携带 `resumeFromRunId` |
| 接管 | `takeoverFromRunId`；守卫错误包含旧 run ID |
| 队列 | `chats:pending-enqueue/list/claim/complete-dispatch/remove/edit/adjust/unmark` |
| 审批 | `permission:approval-request/resolve/settled` |
| 选择卡 | `choice:resolve`、`firefly.choice.dismiss` |
| 编辑 | `chats:replace-tail` 与 `transcriptRewind` |
| 听写 | `desktop-asr:start/frame/stop/cancel` |

证据：`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`pages/chat-page-bridge.ts`。

失败测试使用真实稳定代码，例如 `E_MODEL_CONNECTION_LOST`、`E_MODEL_REQUEST_TIMEOUT`、`SESSION_RUN_ACTIVE:<runId>`；断言代码、所属会话及必要上下文，同时确认私密服务响应、凭据和模型原始错误未进入 UI 或持久化。依据：`src/shared/run-failure.ts`、控制器的公开错误映射及现有错误测试。

### 设计细节 4：三模式表现矩阵

| 项目 | Chat | Work | Code |
| --- | --- | --- | --- |
| 回答与过程 | 流式回答；实际产生时展示 reasoning、工具过程 | 回答、工具时间线、任务结果及读取证据 | 回答、工具过程、代码变更及差异入口 |
| 取消、终态、队列 | 全部验收 | 全部验收 | 全部验收 |
| 刷新恢复 | 验证历史呈现、无残留动画；当前不显示任务继续提示 | 验证中断提示及“继续任务” | 同 Work |
| 接管 | 验证冲突、单卡和定向重开 | 同 Chat | 同 Chat |
| 审批、选择卡 | 有相应事件时验收 | 有相应事件时验收 | 有相应事件时验收 |
| 计划 | 验证当前监听行为；完整面板另定产品行为，本主题先验 Code | 当前不监听延后计划事件 | 完整审阅、批准、补充、执行及完成 |
| 语音 | 转写追加当前草稿，用户主动发送 | 同 Chat | 同 Chat |
| 附件 | 图片及实际允许的文档导入；不显示 Work/Code 专属必读控制 | 图片、文档及必读控制 | 图片、文档及必读控制 |
| 编辑、重生成 | 仅空闲时操作最后一轮 | 不提供入口、不派发 | 不提供入口、不派发 |
| Todo | 验证状态隔离及实际产生事件的呈现，不强制增加面板 | 步骤胶囊、恢复及新轮次重置 | 步骤胶囊与 `CodeGitPanel` |
| 上下文 | 实时值、终态值、压缩提示 | 同 Chat | 同 Chat |
| TTS | 本主题暂不承诺正向播放；新增交付另列计划 | 同 Chat | 同 Chat |

界面断言使用中文 i18n，例如：

- `chatPage.lastRunInterrupted`：“上次运行已中断”。
- `workspaceNotices.resumeTask`：“继续任务”。
- `workspaceNotices.takeoverAndRestart`：“终止并重开”。
- `chatPage.planApprovedAutoMessage`：“已批准计划，请开始执行。”
- `dictation.hint`：“音频发往所选 ASR 服务，转写仅填入草稿，不自动发送。”

不为测试新增硬编码产品文案。

## 文件清单

以下为后续施工清单，`pages/`、`components/`、`hooks/` 的路径已展开。

### 新建

- `docs/qa/1.2.0-chatpage-regression-checklist.md`
- `docs/qa/1.2.0-chatpage-regression-results.md`
- `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`
- `src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts`

### 修改

- `src/main/chat/agui-bridge.test.ts`
- `src/main/chats/chats-pending-queue.test.ts`
- `src/main/chats/chats-store.test.ts`
- `src/renderer/react/features/chat/components/ChatComposer.test.ts`
- `src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts`
- `src/renderer/react/features/chat/components/DesktopAsrButton.test.ts`
- `src/renderer/react/features/chat/components/PlanReviewPanel.test.ts`
- `src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`
- `src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`
- `src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`
- `src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts`
- `src/renderer/react/features/chat/pages/interaction-events.test.ts`
- `src/renderer/react/features/chat/pages/interaction-owner.test.ts`
- `src/renderer/react/features/chat/pages/interaction-owner.ts`
- `src/renderer/react/features/chat/pages/interaction-resolution.test.ts`
- `src/renderer/react/features/chat/pages/last-turn-revision.test.ts`
- `src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`
- `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`
- `src/renderer/react/features/chat/pages/session-snapshot.test.ts`

生产文件原则上不预列为必改项，施工包 G 已确认的归属修复除外。若失败测试证明当前实现违反其他已确认契约，先记录复现，再单列最小修复与复现测试；不借本主题调整公共类型、目录策略或扩大功能范围。

## 施工包

每个施工包 = 一个 PR。建议合并顺序：A → B → G → C → D → E → F。D、E 满足各自依赖后可独立安排；共享页面组合测试的冲突需核对。F 的正式包验收另依赖启动与存储主题落实新数据目录。

文件数按每包明确列出的唯一文件计，测试另列；各包均 ≤15 个非测试文件。若复现修复使包超过 15 个非测试文件或上千行，优先拆包；确实不能拆时写明跨模块契约原因并附完整链路验证。版本号、纯格式化或无关重构不得混入。

### 施工包 A：清单、运行与持久化基线

依赖：无（先核对实施基线）

**改动文件：** 共 4 个（测试 3 个，非测试 1 个）。

| 文件 | 改动 |
| --- | --- |
| `docs/qa/1.2.0-chatpage-regression-checklist.md` | 固定基线、模式矩阵、执行方法、结果分类和证据字段。初始状态全部为未执行。 |
| `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts` | 补三模式运行、终态状态组合、上下文与取消边界中的缺项。 |
| `src/main/chats/chats-store.test.ts` | 补四类终态真实落盘、模块重载读取及未完成快照保留。 |
| `src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts` | 补存储结果恢复后的正式回答、过程、动画和结算投影。 |

**已定结论：** 实施基线采用届时 dev/firefly-1.2.0 确认提交；先补齐相对 c991111 差异，保留原基线说明。

**任务：**

- [ ] A1 三模式分别收到 reasoning、正文和成功终态
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：三模式分别收到 reasoning、正文和成功终态 → 正文与过程顺序正确；流式结束后无 loading；最终检查点包含正确 run、用户锚点和终态；只报告一次持久化完成。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：以三模式表驱动补控制器运行缺项；同时新增 QA 清单，固定基线、模式矩阵、执行方法、结果分类和证据字段，初始全部未执行。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A2 Work/Code 经工具过程后回答
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：Work/Code 经工具过程后回答 → 工具状态、结果、变更和正式回答分别可观察；工具过程不能被误当正式回答重复保存。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补工具过程与正式回答投影组合。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A3 已有部分输出后取消
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：已有部分输出后取消 → 正式回答不提交；部分过程保留；终态为 cancelled；迟到正文不能重新写回；另一会话不受影响。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补输出中取消、部分过程及迟到正文隔离。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A4 发送后、ack 前取消
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：发送后、ack 前取消 → ack 返回后仅取消其分配的 run；不执行 cancel-all；没有孤儿 run 或残留 busy。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补 ack 前后定向取消衔接，沿用现有协议。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A5 网络中断、请求超时、runtime_error
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：网络中断、请求超时、runtime_error → 精确代码与中文公开提示正确；终态及过程落盘；原始私密错误不进入展示或文件。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用公开错误映射，补稳定代码与中文提示。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A6 旧检查点写入延迟，终态随后到达
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：旧检查点写入延迟，终态随后到达 → 最后重载结果为终态，不能被 running 覆盖；不能提前报告持久化完成。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：可控延迟交错检查点和终态写入，以实际文件重载确认顺序。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A7 四类终态分别保存后重载模块
  - 先写的测试：`src/main/chats/chats-store.test.ts`：四类终态分别保存后重载模块 → 读取的 `runSnapshot`、正文和过程符合原终态；不统一变为 interrupted。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：独立临时目录真实落盘并重载模块，完整比较快照、正文和过程。
  - 验证：`npm test -- src/main/chats/chats-store.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A8 running/waiting_user 检查点重载
  - 先写的测试：`src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts`：running/waiting_user 检查点重载 → 页面停止动画，呈现中断；不伪装成功，不自动重放工具。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：衔接存储结果和恢复投影，覆盖未完成检查点与动画。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A9 上下文实时事件、终态事件和新 run
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：上下文实时事件、终态事件和新 run → 快照只更新所属会话；最终值保留；新 run 按现有逻辑复位压缩提示；外来 run 不影响当前显示。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补上下文事件过滤、终态值和新 run 压缩提示复位。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] A10 持久化写入拒绝
  - 先写的测试：`src/main/chats/chats-store.test.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：写入拒绝 → 不能假报完成，也不能丢失已确认的旧记录；不提前报告持久化完成、不覆盖旧记录。
  - 实现：补真实临时文件失败场景与控制器结算衔接。失败分类以复现结果为准，不提前声称现有实现有缺陷。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chats/chats-store.test.ts src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts`

**最近测试命令：**

```powershell
npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chats/chats-store.test.ts src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts
```

**验收：** 本包全部任务有对应测试，最近测试通过并记录退出码、归档报告、失败和显式跳过原因；涉及界面或运行行为在开发版或打包版实际操作，在 PR 记录完整链路步骤及结果。

**回退：** 按包整体 revert A 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 B：恢复、接管与队列组合

依赖：施工包 A

**改动文件：** 共 4 个（测试 4 个，非测试 0 个）。

| 文件 | 改动 |
| --- | --- |
| `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts` | 使用实际 `ChatPage`、队列流程与控制器，替换网络、系统服务和 IPC；不 mock 掉正在验证的运行链路。先覆盖刷新、接管和多会话。 |
| `src/renderer/react/features/chat/pages/pending-queue-flow.test.ts` | 补各终态后消费、拒绝后暂停、入队期间编辑及跨会话组合缺项。 |
| `src/main/chat/agui-bridge.test.ts` | 只补组合测试暴露的守卫契约空缺，复用已有并发、陈旧取消和接管等待场景。 |
| `src/main/chats/chats-pending-queue.test.ts` | 补页面组合所需且尚无等价覆盖的认领恢复、稳定 ID 和写失败场景。 |

**已定结论：** 不重写守卫，不另建页面队列；权威认领及恢复沿用现有数据结构。

**任务：**

- [ ] B1 Work/Code 打开有中断任务的会话并点击“继续任务”
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：Work/Code 打开有中断任务的会话并点击“继续任务” → 只发起一次提交，准确携带 `resumeFromRunId`；不清其他会话状态，不直接重放工具。Chat 不出现该任务恢复入口。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：保留实际 ChatPage、队列流程和控制器；仅替换网络、系统服务和 IPC。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B2 刷新后发送遭遇 `SESSION_RUN_ACTIVE`
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：刷新后发送遭遇 `SESSION_RUN_ACTIVE` → 显示一个“终止并重开”入口；没有第二个合法 owner；再次发送不复制接管卡或形成重试风暴。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补刷新冲突的单卡、合法 owner 与无重试风暴组合。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B3 接管旧 run，旧终态与取消迟到
  - 先写的测试：`src/main/chat/agui-bridge.test.ts`：接管旧 run，旧终态与取消迟到 → 新请求携带原 run ID；旧 run 先按守卫结算；旧取消不杀新 run，旧终态不覆盖新消息。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用已有并发和陈旧取消场景，补跨会话接管链路。
  - 验证：`npm test -- src/main/chat/agui-bridge.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B4 接管等待超过当前实现时限
  - 先写的测试：`src/main/chat/agui-bridge.test.ts`：接管等待超过当前实现时限 → 精确断言 `SESSION_RUN_TAKEOVER_STUCK:<runId>`；无重复启动、无悬空 busy。时限取自实现，以假时钟测试边界及两侧。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用已有接管等待测试，以实现时限和假时钟测临界点及两侧。
  - 验证：`npm test -- src/main/chat/agui-bridge.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B5 忙会话依次发送两条消息并删除其中一条
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：忙会话依次发送两条消息并删除其中一条 → 队列完整顺序正确；仅成功入队后清发送快照；删除只作用目标 ID，不写正式历史。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补权威入队、目标删除和发送快照衔接。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B6 已接受 run 以四类终态结束
  - 先写的测试：`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`：已接受 run 以四类终态结束 → 按现有策略启动下一条且仅一次，每条正常经过 claim、ack、终态；另一会话可独立运行。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：以四终态表驱动补一次后继消费及邻会话独立性。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B7 派发被拒绝或 `queuePaused:true`
  - 先写的测试：`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`：派发被拒绝或 `queuePaused:true` → 保留权威认领和队列恢复入口，不循环认领、不重复追加用户消息。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补派发拒绝、暂停与恢复入口，不另建页面队列。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B8 入队返回失败或传输异常后重试
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：入队返回失败或传输异常后重试 → 草稿、附件保留；没有模型派发；重试使用稳定身份，最终只存在一条待发消息。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：以稳定 ID 衔接失败重试与页面草稿、附件。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B9 入队等待期间继续输入、添加附件
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：入队等待期间继续输入、添加附件 → 旧消息成功后只清发送时快照，新文字和新附件保持完整。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：控制入队 promise，保留等待期间的新文字、新附件。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] B10 认领后刷新、保存失败、缺少认领用户锚点
  - 先写的测试：`src/main/chats/chats-pending-queue.test.ts`：认领后刷新、保存失败、缺少认领用户锚点 → 不重复追加已存在用户消息；损坏只暂停所属会话；不擅自清账或影响邻会话。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用已有 FIFO、幂等、真实重启和写失败场景，补认领恢复组合缺项。
  - 验证：`npm test -- src/main/chats/chats-pending-queue.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

**最近测试命令：**

```powershell
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/pending-queue-flow.test.ts src/main/chat/agui-bridge.test.ts src/main/chats/chats-pending-queue.test.ts
```

**验收：** 本包全部任务有对应测试，最近测试通过并记录退出码、归档报告、失败和显式跳过原因；涉及界面或运行行为在开发版或打包版实际操作，在 PR 记录完整链路步骤及结果。

**回退：** 按包整体 revert B 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 C：审批、选择卡与计划

依赖：施工包 B、施工包 G

**改动文件：** 共 5 个（测试 5 个，非测试 0 个）。

| 文件 | 改动 |
| --- | --- |
| `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts` | 增加审批、选择卡、取消结算、后台 owner 和页面切换操作。 |
| `src/renderer/react/features/chat/pages/interaction-resolution.test.ts` | 补 `ok:false`、传输异常、重复结算和取消交错中的缺项。 |
| `src/renderer/react/features/chat/pages/interaction-events.test.ts` | 补 `ok:false`、传输异常、重复结算和取消交错中的缺项。 |
| `src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts` | 补真实批准动作、执行消息次数、补充内容及面板入口断言。保留现有严格完成身份测试。 |
| `src/renderer/react/features/chat/components/PlanReviewPanel.test.ts` | 补实际按钮防重复提交、失败后可重试及中文状态呈现。 |

**已定结论：** 完整计划交互验收先以 Code 为准；Chat 监听与面板差异单独定产品行为，Work 保持当前不启用。同一批准必须端到端只产生一条执行消息；按钮防重复之外，先核对事件稳定批准身份，若字段不足，具体契约变更仍需确认。现有 dispatchAttemptId 表示派发尝试，不能自动当作事件去重身份。

**任务：**

- [ ] C1 审批允许或拒绝
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：审批允许或拒绝 → 传给 `resolvePermissionApproval` 的 ID、布尔值和次数准确；卡按结算消失；拒绝时受保护操作未执行。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补页面允许、拒绝与卡片结算链路。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C2 卡片提交返回 `ok:false`
  - 先写的测试：`src/renderer/react/features/chat/pages/interaction-resolution.test.ts`：卡片提交返回 `ok:false` → 卡清除、不恢复运行；其他卡和会话保持不变。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补拒绝结算与运行状态。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/interaction-resolution.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C3 卡片提交发生传输异常
  - 先写的测试：`src/renderer/react/features/chat/pages/interaction-resolution.test.ts`：卡片提交发生传输异常 → 卡保留供重试，busy 解除；不误报允许或重复执行。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补异常重试、busy 解除和无误报允许。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/interaction-resolution.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C4 审批挂起时取消，之后结算或请求重播
  - 先写的测试：`src/renderer/react/features/chat/pages/interaction-events.test.ts`：审批挂起时取消，之后结算或请求重播 → 目标卡和排队卡正确清理；重播不制造重复卡；不影响邻会话。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用去重、排队和跨会话清卡测试，补取消交错。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/interaction-events.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C5 已知后台 run 发出审批
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：已知后台 run 发出审批 → 卡只属于后台会话；切换后可见，前台会话不被更新。未知 run 使用 G1 已定隔离规则；无 run ID 的合法请求另定规则。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补已知后台 owner 切换可见；未知 run 按 G1 已定隔离规则。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C6 选择卡提交、dismiss、重复结算
  - 先写的测试：`src/renderer/react/features/chat/pages/interaction-resolution.test.ts`：选择卡提交、dismiss、重复结算 → 完整卡列表及推进结果正确；只提交一次；终态后不残留可操作僵尸卡。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补完整卡列表、提交一次和推进结果。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/interaction-resolution.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C7 Code 收到 review、用户批准
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`：Code 收到 review、用户批准 → 面板内容及激活标签正确；执行消息准确为中文 i18n 文案，且只入队一次；按钮等待期间不能重复提交。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补真实批准动作、面板入口、中文状态和执行消息次数；核对稳定批准身份，验证同一批准端到端幂等。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C8 用户提交计划补充
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`：用户提交计划补充 → 原文本只发送一次并回到修改、审阅链路；不能直接标记计划已完成。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补原始补充内容与修改、审阅链路。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C9 正确身份完成；缺失或错误身份完成
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`：正确身份完成；缺失或错误身份完成 → 只有匹配 thread、run、路径及成功状态的计划完成；其余不改变当前或后台计划。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：保留严格完成身份绑定，复用重复、陈旧完成和取消测试。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C10 run 结束后到达 review/supplement，或页面切换
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`：run 结束后到达 review/supplement，或页面切换 → 按实际持久监听范围处理；不依赖已移除的 run 订阅，不将 A 的计划显示或提交到 B。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：按实际持久监听范围注入迟到事件并切换页面。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] C11 批准后模型服务不可用或入队失败
  - 先写的测试：`src/renderer/react/features/chat/components/PlanReviewPanel.test.ts`：批准后模型服务不可用或入队失败 → 对应批准尝试进入失败状态；无假 executing/completed；不覆盖后来批准的尝试。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补按钮防重复、失败可重试及中文状态；在 ChatPage.plan-lifecycle.test.ts 补批准尝试失败与后来尝试隔离。
  - 验证：`npm test -- src/renderer/react/features/chat/components/PlanReviewPanel.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

已有重复、陈旧完成和取消测试直接复用，避免为相同契约再建一套测试。

**最近测试命令：**

```powershell
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/interaction-resolution.test.ts src/renderer/react/features/chat/pages/interaction-events.test.ts src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts src/renderer/react/features/chat/components/PlanReviewPanel.test.ts
```

**验收：** 本包全部任务有对应测试，最近测试通过并记录退出码、归档报告、失败和显式跳过原因；涉及界面或运行行为在开发版或打包版实际操作，在 PR 记录完整链路步骤及结果。

**回退：** 按包整体 revert C 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 D：会话、编辑、Todo 与上下文

依赖：施工包 B

**改动文件：** 共 5 个（测试 5 个，非测试 0 个）。

| 文件 | 改动 |
| --- | --- |
| `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts` | 三模式切换、会话切换、冷启动、管理操作及面板隔离。 |
| `src/renderer/react/features/chat/pages/last-turn-revision.test.ts` | 补尾轮已改变、存储拒绝、空编辑及完整 rewind 参数。 |
| `src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts` | 验证 Hook 的模式限制、busy 与并发 revision 防护。 |
| `src/renderer/react/features/chat/pages/session-snapshot.test.ts` | 补无快照、终态 Todo、活跃运行优先和邻会话不变。 |
| `src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts` | 补三模式入口显示及禁用状态。 |

**已定结论：** Chat 编辑限制保持不变；Todo 与上下文不增加第二份权威状态。

**任务：**

- [ ] D1 冷启动使用三种合法上次模式，或 URL 指向会话
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：冷启动使用三种合法上次模式，或 URL 指向会话 → 实际选中模式、会话、消息和列表一致；迟到初始化不能覆盖后来用户选择。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补冷启动、URL 打开及迟到初始化。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D2 快速选择 A→B→C，响应逆序返回
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：快速选择 A→B→C，响应逆序返回 → 最终只显示 C 的消息、标题、草稿、附件和工作区；A/B 不能抢回选中状态。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：复用 openSessionByDeps.race 场景，补真实页面完整状态断言。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D3 欢迎页暂选模型、工作区后首次发送
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：欢迎页暂选模型、工作区后首次发送 → 创建及绑定到正确会话；模型不丢失；绑定失败时不越过失败启动运行。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补暂选模型、工作区绑定及失败禁止启动。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D4 新建任务、重命名、删除、置顶及各自失败
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：新建任务、重命名、删除、置顶及各自失败 → 列表和当前选择符合主进程回复；失败不能假成功；未操作会话及文件保持不变。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：按管理操作与失败表驱动验证主进程回复投影。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D5 Chat 编辑最后用户消息或重新生成
  - 先写的测试：`src/renderer/react/features/chat/pages/last-turn-revision.test.ts`：Chat 编辑最后用户消息或重新生成 → 精确比较 `replaceTail` 的位置和完整消息；用户锚点、附件、`transcriptRewind` 正确；只启动一次。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补完整 replaceTail 与 transcriptRewind 参数和调用次数。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/last-turn-revision.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D6 忙、并发 revision、空编辑、磁盘尾轮已变化、replaceTail 拒绝
  - 先写的测试：`src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts`：忙、并发 revision、空编辑、磁盘尾轮已变化、replaceTail 拒绝 → 不派发新 run、不截断错误历史；状态锁最终释放。Work/Code 同样不调用尾轮修改或派发。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补 Hook 模式、busy、并发保护；在 last-turn-revision.test.ts、ChatMessageList.last-turn.test.ts 补存储失败及入口禁用。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D7 Todo 更新后切走再返回，随后新 run
  - 先写的测试：`src/renderer/react/features/chat/pages/session-snapshot.test.ts`：Todo 更新后切走再返回，随后新 run → 恢复正确会话快照；新 run 仅清自己的 Todo；旧 run 事件不覆盖新 Todo，邻会话列表及顺序不变。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补终态 Todo、活跃运行优先、新轮次与邻会话不变。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/session-snapshot.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] D8 上下文无快照、有会话快照、仅有消息快照
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：上下文无快照、有会话快照、仅有消息快照 → 无数据不伪造数值；优先级符合 `ChatPage`；切换后不串用其他会话数值。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补快照来源优先级和实际组件呈现；Code 另验 CodeGitPanel Todo。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

**最近测试命令：**

```powershell
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts src/renderer/react/features/chat/pages/last-turn-revision.test.ts src/renderer/react/features/chat/pages/session-snapshot.test.ts src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts
```

**验收：** 本包全部任务有对应测试，最近测试通过并记录退出码、归档报告、失败和显式跳过原因；涉及界面或运行行为在开发版或打包版实际操作，在 PR 记录完整链路步骤及结果。

**回退：** 按包整体 revert D 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 E：听写与附件

依赖：施工包 B

**改动文件：** 共 5 个（测试 5 个，非测试 0 个）。

| 文件 | 改动 |
| --- | --- |
| `src/renderer/react/features/chat/components/DesktopAsrButton.test.ts` | 补会话切换、失焦、权限、超时和迟到转写中的缺项。 |
| `src/renderer/react/features/chat/components/desktop-asr-controller.test.ts` | 补会话切换、失焦、权限、超时和迟到转写中的缺项。 |
| `src/renderer/react/features/chat/components/ChatComposer.test.ts` | 三模式转写追加草稿、保留附件、不自动提交及主动发送。 |
| `src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts` | 补粘贴临界值、截图原因、异步 scope、策略失败及完整附件状态断言。 |
| `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts` | 将附件、听写与权威入队、草稿清理串联验证。 |

**已定结论：** 本主题只验现有“转写填草稿、主动发送”；语音自动发送与后台提交另立功能需求，不借回归增加入口。

**任务：**

- [ ] E1 三模式已有草稿、附件后收到转写
  - 先写的测试：`src/renderer/react/features/chat/components/ChatComposer.test.ts`：三模式已有草稿、附件后收到转写 → 按实际空格规则追加文字，附件保持完整；未调用提交、入队或模型启动。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补三模式转写追加与页面权威入队衔接；保持听写填草稿、用户主动发送。
  - 验证：`npm test -- src/renderer/react/features/chat/components/ChatComposer.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E2 录音、转写期间取消、失焦、切会话或卸载
  - 先写的测试：`src/renderer/react/features/chat/components/DesktopAsrButton.test.ts`：录音、转写期间取消、失焦、切会话或卸载 → 主进程收到目标录音取消；迟到结果不能写入新草稿；不发送消息。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补录音及转写异步取消和迟到结果。
  - 验证：`npm test -- src/renderer/react/features/chat/components/DesktopAsrButton.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E3 未配置、麦克风拒绝、空文本、超时
  - 先写的测试：`src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`：未配置、麦克风拒绝、空文本、超时 → 精确错误代码与对应中文提示；权限失败不继续采集，失败不填草稿、不发送。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：以可预测 ASR 与系统权限替身验证错误码及中文提示。
  - 验证：`npm test -- src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E4 录音启动、停止超时和 PCM 队列边界
  - 先写的测试：`src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`：录音启动、停止超时和 PCM 队列边界 → 按当前实现常量测试临界点及两侧；只停止或取消一次，不遗留设备与定时器。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：按实际常量与假时钟补边界，结束恢复定时器。
  - 验证：`npm test -- src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E5 图片大小为 20 MiB−1、20 MiB、20 MiB+1
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：图片大小为 20 MiB−1、20 MiB、20 MiB+1 → 前两者按规则保存，超限拒绝；拒绝时不调用保存、不新增附件、不进入 busy。文案使用当前 i18n。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补粘贴图片临界值和当前 i18n。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E6 同时拖入图片、文档并嵌套 drag enter/leave
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：同时拖入图片、文档并嵌套 drag enter/leave → 附件按导入结果保持完整顺序；只给图片生成预览；遮罩正确收起，不擅自过滤文档。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补图片、文档混合导入完整顺序及嵌套拖拽遮罩。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E7 截图成功或返回各类 reason
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：截图成功或返回各类 reason → 成功加入目标 scope；取消为信息提示，helper 未就绪和文件缺失提示准确；失败不留下假附件。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：按截图 reason 表驱动验证目标 scope。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E8 caption 成功、空描述、失败；direct 策略
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：caption 成功、空描述、失败；direct 策略 → UI 附件完整状态序列正确；direct 不调用 caption；某图片失败不串改另一文件。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补 caption/direct 完整状态序列及单文件失败隔离。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E9 导入或 caption 未结束时切会话
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：导入或 caption 未结束时切会话 → 结果只写原所属会话或消息；当前会话附件不被污染。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：延迟导入或 caption，切换 scope 后观察归属。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E10 删除附件、成功发送、失败发送、发送中新增附件
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：删除附件、成功发送、失败发送、发送中新增附件 → 仅删除目标项；成功只清发送快照；失败全部保留；新附件不被误清。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：在 Hook 与页面组合测试衔接附件发送快照和主进程权威队列。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

- [ ] E11 创建预览后卸载
  - 先写的测试：`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：创建预览后卸载 → 对应 object URL 全部释放，不重复撤销无关资源。 同时断言无额外派发、意外写入或跨会话更新。
  - 实现：补预览 object URL 释放及无关资源保护。
  - 验证：`npm test -- src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`；任务涉及多个测试文件时，再执行本包最近测试命令。

**最近测试命令：**

```powershell
npm test -- src/renderer/react/features/chat/components/DesktopAsrButton.test.ts src/renderer/react/features/chat/components/desktop-asr-controller.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts src/renderer/react/features/chat/pages/ChatPage.regression.test.ts
```

**验收：** 本包全部任务有对应测试，最近测试通过并记录退出码、归档报告、失败和显式跳过原因；涉及界面或运行行为在开发版或打包版实际操作，在 PR 记录完整链路步骤及结果。

**回退：** 按包整体 revert E 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 F：完整回归与归档

依赖：施工包 A、施工包 B、施工包 C、施工包 D、施工包 E、施工包 G；正式包另依赖新目录契约落地

**改动文件：** 共 2 个（测试 0 个，非测试 2 个）。

| 文件 | 改动 |
| --- | --- |
| `docs/qa/1.2.0-chatpage-regression-checklist.md` | 逐项填写结果、模式适用性、失败或阻塞原因。 |
| `docs/qa/1.2.0-chatpage-regression-results.md` | 记录最终提交、命令退出码、现有测试报告位置、脱敏真机证据及未验证项。 |

**已定结论：** 正式目录为 %APPDATA%\Firefly-1.2.0，由启动与存储主题落实，禁止扫描、回退或迁移 1.1.x 目录；该契约是正式包验收前置条件，本主题复用隔离能力。所有适用自动化测试通过，取消、落盘恢复、接管、队列和审批真机项无未决失败。服务阻塞及不适用项单独签收，不能折算通过。本主题暂不承诺 TTS 正向播放验收；若要求交付，先明确已有入口或单列实现计划，再增加分句、打断、收尾和缓存验收。

**任务：**

- [ ] F1 真机：**三模式基本流程**：分别完成普通回答、reasoning、工具过程；Work 验任务结果和读取证据，Code 验文件变更及差异入口。另验适用的用户和模型表情包、过程折叠及结束后滚动。
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F2 真机：**取消与故障**：极快停止、输出中停止、审批中停止；停止后立即发送；模型断网和超时后确认无 loading 卡死、无正式回答误提交。
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F3 真机：**刷新与重启**：运行中 F5 后验证接管；Work/Code 验中断继续。分别在已确认终态保存后、运行未结束时关闭进程再重开，比较历史、过程、Todo、上下文和待发队列。
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F4 真机：**多会话与队列**：A 运行时向 A 连发、删除待发项，同时运行 B；快速切换，确认卡片、草稿、附件和结果不串台。
  - 先写的测试：`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F5 真机：**交互与计划**：允许、拒绝、取消、重复点击；Code 审阅、批准、补充、执行失败和成功，核对执行消息次数。
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F6 真机：**听写与附件**：真实麦克风权限、取消及转写；图片和文档拖入、粘贴、截图、描述与直传，核对中文提示和发送清理。
  - 先写的测试：`src/renderer/react/features/chat/components/ChatComposer.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/components/ChatComposer.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F7 真机：**会话管理与编辑**：三模式选择恢复，新建、改名、删除、置顶，Chat 编辑和重生成。
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F8 真机：**TTS**：仅在负责人确认已有可用链路并明确入口后加入正向验收；否则记录范围差异，不填写通过。
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：对应模式与故障输入 → 先由 A–E 已绑定断言固定结果及禁止副作用，再执行全量清单同号真机步骤；替身不替代真机通过。
  - 实现：更新 QA 清单并归档该场景结果、模式适用性、脱敏证据和失败或阻塞原因。TTS 本轮只记录范围差异，不填播放通过。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；`npm run dev`（按隔离步骤）；正式包执行现有 `npm run package:win:dir` 后逐项实际操作。

- [ ] F9 全量验证与结果归档
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：全部适用输入及故障 → 各包对应可观察结果及禁止副作用成立；不把失败、阻塞、不适用或缺证据计为通过。
  - 实现：新建 QA 结果文档，记录最终提交、命令退出码、报告位置、三模式真机证据及未验证项；对照清单逐项填写，不增加产品字段。
  - 验证：`npm test`；`npm run check:renderer`；`npm run check:storage-boundary`；`npm run build:main`；`npm run build:preload`；`npm run build:renderer`；`git diff --check`。

**验收：** 全量清单、自动化报告及三模式真机记录完整；服务阻塞、不适用项单独签收。正式新目录契约未落地前不得宣布正式包通过。

**回退：** 按包整体 revert F 的合并提交（施工时记录真实 SHA）；测试与文档可独立回退，不迁移产品数据。若另附已复现生产修复，修复及复现测试同一独立变更；回退不删除失败证据、不削弱已有断言。

### 施工包 G：未知 run 审批归属修复

依赖：施工包 B

**改动文件：** 共 3 个（测试 2 个，非测试 1 个）。

| 文件 | 改动 |
| --- | --- |
| `src/renderer/react/features/chat/pages/interaction-owner.ts` | 收紧已携带未知 run 的归属，保留已知 owner 优先。 |
| `src/renderer/react/features/chat/pages/interaction-owner.test.ts` | 更新当前未知 run 回退断言，补已知后台和无可见会话。 |
| `src/renderer/react/features/chat/pages/ChatPage.regression.test.ts` | 页面审批事件不向当前或邻会话误投卡。 |

**已定结论：** 已携带但无法归属的 run 不回退当前会话，避免误投卡。该项改变当前实现，必须独立修复及测试，不能冒充已有实现已满足的回归标准。无 run ID 的合法请求另定规则，本包不擅改该分支，也不把现状作为已确认契约。

**任务：**

- [ ] G1 已携带未知 run 的审批不误投可见会话
  - 先写的测试：`src/renderer/react/features/chat/pages/interaction-owner.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`：已知后台 run、未知 run、有或无可见会话 → 已知 run 只投真实 owner；未知 run 无 owner、页面不建卡；不调用审批 resolve、不执行受保护操作、不改变邻会话。无 run ID 现状另做兼容记录，不替负责人决定。
  - 实现：在 `interactionOwner(activeRuns, runId, visibleSessionId)` 收紧已携带未知 run 的分支，保持函数签名，经真实页面 deliver 链路验证无误投；无需改公共 IPC 类型。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/interaction-owner.test.ts src/renderer/react/features/chat/pages/ChatPage.regression.test.ts`；`npm run check:renderer`。

**验收：** 先复现原回退行为，再证明未知 run 不误投、已知后台 owner 不变；无 run ID 未决规则不得冒充通过标准。

**回退：** 按包整体 revert G 的合并提交（施工时记录实际 SHA）；不产生或迁移数据。回退恢复误投风险，须保留失败证据并阻止该项发布验收通过。

## 验收清单（全量）

### 自动化逐项验收

- [ ] A1：三模式分别收到 reasoning、正文和成功终态 → 正文与过程顺序正确；流式结束后无 loading；最终检查点包含正确 run、用户锚点和终态；只报告一次持久化完成。
- [ ] A2：Work/Code 经工具过程后回答 → 工具状态、结果、变更和正式回答分别可观察；工具过程不能被误当正式回答重复保存。
- [ ] A3：已有部分输出后取消 → 正式回答不提交；部分过程保留；终态为 cancelled；迟到正文不能重新写回；另一会话不受影响。
- [ ] A4：发送后、ack 前取消 → ack 返回后仅取消其分配的 run；不执行 cancel-all；没有孤儿 run 或残留 busy。
- [ ] A5：网络中断、请求超时、runtime_error → 精确代码与中文公开提示正确；终态及过程落盘；原始私密错误不进入展示或文件。
- [ ] A6：旧检查点写入延迟，终态随后到达 → 最后重载结果为终态，不能被 running 覆盖；不能提前报告持久化完成。
- [ ] A7：四类终态分别保存后重载模块 → 读取的 `runSnapshot`、正文和过程符合原终态；不统一变为 interrupted。
- [ ] A8：running/waiting_user 检查点重载 → 页面停止动画，呈现中断；不伪装成功，不自动重放工具。
- [ ] A9：上下文实时事件、终态事件和新 run → 快照只更新所属会话；最终值保留；新 run 按现有逻辑复位压缩提示；外来 run 不影响当前显示。
- [ ] B1：Work/Code 打开有中断任务的会话并点击“继续任务” → 只发起一次提交，准确携带 `resumeFromRunId`；不清其他会话状态，不直接重放工具。Chat 不出现该任务恢复入口。
- [ ] B2：刷新后发送遭遇 `SESSION_RUN_ACTIVE` → 显示一个“终止并重开”入口；没有第二个合法 owner；再次发送不复制接管卡或形成重试风暴。
- [ ] B3：接管旧 run，旧终态与取消迟到 → 新请求携带原 run ID；旧 run 先按守卫结算；旧取消不杀新 run，旧终态不覆盖新消息。
- [ ] B4：接管等待超过当前实现时限 → 精确断言 `SESSION_RUN_TAKEOVER_STUCK:<runId>`；无重复启动、无悬空 busy。时限取自实现，以假时钟测试边界及两侧。
- [ ] B5：忙会话依次发送两条消息并删除其中一条 → 队列完整顺序正确；仅成功入队后清发送快照；删除只作用目标 ID，不写正式历史。
- [ ] B6：已接受 run 以四类终态结束 → 按现有策略启动下一条且仅一次，每条正常经过 claim、ack、终态；另一会话可独立运行。
- [ ] B7：派发被拒绝或 `queuePaused:true` → 保留权威认领和队列恢复入口，不循环认领、不重复追加用户消息。
- [ ] B8：入队返回失败或传输异常后重试 → 草稿、附件保留；没有模型派发；重试使用稳定身份，最终只存在一条待发消息。
- [ ] B9：入队等待期间继续输入、添加附件 → 旧消息成功后只清发送时快照，新文字和新附件保持完整。
- [ ] B10：认领后刷新、保存失败、缺少认领用户锚点 → 不重复追加已存在用户消息；损坏只暂停所属会话；不擅自清账或影响邻会话。
- [ ] C1：审批允许或拒绝 → 传给 `resolvePermissionApproval` 的 ID、布尔值和次数准确；卡按结算消失；拒绝时受保护操作未执行。
- [ ] C2：卡片提交返回 `ok:false` → 卡清除、不恢复运行；其他卡和会话保持不变。
- [ ] C3：卡片提交发生传输异常 → 卡保留供重试，busy 解除；不误报允许或重复执行。
- [ ] C4：审批挂起时取消，之后结算或请求重播 → 目标卡和排队卡正确清理；重播不制造重复卡；不影响邻会话。
- [ ] C5：已知后台 run 发出审批 → 卡只属于后台会话；切换后可见，前台会话不被更新。未知 run 使用 G1 已定隔离规则；无 run ID 的合法请求另定规则。
- [ ] C6：选择卡提交、dismiss、重复结算 → 完整卡列表及推进结果正确；只提交一次；终态后不残留可操作僵尸卡。
- [ ] C7：Code 收到 review、用户批准 → 面板内容及激活标签正确；执行消息准确为中文 i18n 文案，且只入队一次；按钮等待期间不能重复提交。
- [ ] C8：用户提交计划补充 → 原文本只发送一次并回到修改、审阅链路；不能直接标记计划已完成。
- [ ] C9：正确身份完成；缺失或错误身份完成 → 只有匹配 thread、run、路径及成功状态的计划完成；其余不改变当前或后台计划。
- [ ] C10：run 结束后到达 review/supplement，或页面切换 → 按实际持久监听范围处理；不依赖已移除的 run 订阅，不将 A 的计划显示或提交到 B。
- [ ] C11：批准后模型服务不可用或入队失败 → 对应批准尝试进入失败状态；无假 executing/completed；不覆盖后来批准的尝试。
- [ ] D1：冷启动使用三种合法上次模式，或 URL 指向会话 → 实际选中模式、会话、消息和列表一致；迟到初始化不能覆盖后来用户选择。
- [ ] D2：快速选择 A→B→C，响应逆序返回 → 最终只显示 C 的消息、标题、草稿、附件和工作区；A/B 不能抢回选中状态。
- [ ] D3：欢迎页暂选模型、工作区后首次发送 → 创建及绑定到正确会话；模型不丢失；绑定失败时不越过失败启动运行。
- [ ] D4：新建任务、重命名、删除、置顶及各自失败 → 列表和当前选择符合主进程回复；失败不能假成功；未操作会话及文件保持不变。
- [ ] D5：Chat 编辑最后用户消息或重新生成 → 精确比较 `replaceTail` 的位置和完整消息；用户锚点、附件、`transcriptRewind` 正确；只启动一次。
- [ ] D6：忙、并发 revision、空编辑、磁盘尾轮已变化、replaceTail 拒绝 → 不派发新 run、不截断错误历史；状态锁最终释放。Work/Code 同样不调用尾轮修改或派发。
- [ ] D7：Todo 更新后切走再返回，随后新 run → 恢复正确会话快照；新 run 仅清自己的 Todo；旧 run 事件不覆盖新 Todo，邻会话列表及顺序不变。
- [ ] D8：上下文无快照、有会话快照、仅有消息快照 → 无数据不伪造数值；优先级符合 `ChatPage`；切换后不串用其他会话数值。
- [ ] E1：三模式已有草稿、附件后收到转写 → 按实际空格规则追加文字，附件保持完整；未调用提交、入队或模型启动。
- [ ] E2：录音、转写期间取消、失焦、切会话或卸载 → 主进程收到目标录音取消；迟到结果不能写入新草稿；不发送消息。
- [ ] E3：未配置、麦克风拒绝、空文本、超时 → 精确错误代码与对应中文提示；权限失败不继续采集，失败不填草稿、不发送。
- [ ] E4：录音启动、停止超时和 PCM 队列边界 → 按当前实现常量测试临界点及两侧；只停止或取消一次，不遗留设备与定时器。
- [ ] E5：图片大小为 20 MiB−1、20 MiB、20 MiB+1 → 前两者按规则保存，超限拒绝；拒绝时不调用保存、不新增附件、不进入 busy。文案使用当前 i18n。
- [ ] E6：同时拖入图片、文档并嵌套 drag enter/leave → 附件按导入结果保持完整顺序；只给图片生成预览；遮罩正确收起，不擅自过滤文档。
- [ ] E7：截图成功或返回各类 reason → 成功加入目标 scope；取消为信息提示，helper 未就绪和文件缺失提示准确；失败不留下假附件。
- [ ] E8：caption 成功、空描述、失败；direct 策略 → UI 附件完整状态序列正确；direct 不调用 caption；某图片失败不串改另一文件。
- [ ] E9：导入或 caption 未结束时切会话 → 结果只写原所属会话或消息；当前会话附件不被污染。
- [ ] E10：删除附件、成功发送、失败发送、发送中新增附件 → 仅删除目标项；成功只清发送快照；失败全部保留；新附件不被误清。
- [ ] E11：创建预览后卸载 → 对应 object URL 全部释放，不重复撤销无关资源。
- [ ] A10：持久化失败需额外验证：写入拒绝时不能假报完成，也不能丢失已确认的旧记录。失败分类以复现结果为准，不提前声称现有实现有缺陷。
- [ ] G1：已携带未知 run 不误投当前会话；已知 owner 不变，不自动 resolve、不执行受保护操作、不改邻会话。

### 真机验证步骤

在 Windows 10/11 的全新隔离目录中，先开发版操作，再在打包版重复所有适用项：

- [ ] F1：**三模式基本流程**：分别完成普通回答、reasoning、工具过程；Work 验任务结果和读取证据，Code 验文件变更及差异入口。另验适用的用户和模型表情包、过程折叠及结束后滚动。
- [ ] F2：**取消与故障**：极快停止、输出中停止、审批中停止；停止后立即发送；模型断网和超时后确认无 loading 卡死、无正式回答误提交。
- [ ] F3：**刷新与重启**：运行中 F5 后验证接管；Work/Code 验中断继续。分别在已确认终态保存后、运行未结束时关闭进程再重开，比较历史、过程、Todo、上下文和待发队列。
- [ ] F4：**多会话与队列**：A 运行时向 A 连发、删除待发项，同时运行 B；快速切换，确认卡片、草稿、附件和结果不串台。
- [ ] F5：**交互与计划**：允许、拒绝、取消、重复点击；Code 审阅、批准、补充、执行失败和成功，核对执行消息次数。
- [ ] F6：**听写与附件**：真实麦克风权限、取消及转写；图片和文档拖入、粘贴、截图、描述与直传，核对中文提示和发送清理。
- [ ] F7：**会话管理与编辑**：三模式选择恢复，新建、改名、删除、置顶，Chat 编辑和重生成。
- [ ] F8：**TTS**：仅在负责人确认已有可用链路并明确入口后加入正向验收；否则记录范围差异，不填写通过。 已定本轮暂不承诺正向播放，记录范围差异；新增交付另列计划。

每项记录具体模式和场景。真实模型、ASR 或截图组件不可用时标记阻塞；替身测试结果不能替代真机通过。

- [ ] F9：全量测试、类型检查、构建和真机验证分别记录日期、提交、环境、命令、退出码、通过数、失败、显式跳过及未验证项。
- [ ] 正式包：运行现有 `npm run package:win:dir` 后打开 `release/win-unpacked` 中实际生成的应用，先确认实际 data、session、日志路径。仅在新目录契约落实且 `%APPDATA%\Firefly-1.2.0` 全新、无正式用户内容的 Windows 测试账户或虚拟机中验收，不清空已有用户目录。确认不扫描、回退或迁移 `%APPDATA%\Firefly` 或任何 1.1.x 数据；重复 F1–F7，F8 记录范围差异。
- [ ] 权限仅三档 `read-only` / `per-action` / `full`，不包含两个旧值；取消、落盘恢复、接管、队列和审批真机项无未决失败；阻塞及不适用单独签收，不能折算通过。
- [ ] 每包一个 PR，CI 通过，按 AGENTS.md 审查；同一 PR 最多三轮；界面及运行改动有实际操作记录。全部包合并且验收完成后，计划、进度状态才可改“已完成”。

下列为后续产品施工与验收命令，施工时执行。

### 验证命令 1：基线核对

```powershell
git rev-parse HEAD
git status --short
git symbolic-ref -q --short HEAD
git show-ref --verify refs/heads/dev/firefly-1.2.0
```

若实施基线不同，先核对本主题文件差异，更新清单中的提交和证据，不把本次盘点直接套到新提交。

### 验证命令 2：最近测试

以下 `npm test -- <路径>` 会经现有 `scripts/testing/run-tests.mjs` 转交 Vitest，并保留现有归档 reporter。

```powershell
# 施工包 A
npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chats/chats-store.test.ts src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts

# 施工包 B
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/pending-queue-flow.test.ts src/main/chat/agui-bridge.test.ts src/main/chats/chats-pending-queue.test.ts

# 施工包 C
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/interaction-resolution.test.ts src/renderer/react/features/chat/pages/interaction-events.test.ts src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts src/renderer/react/features/chat/components/PlanReviewPanel.test.ts

# 施工包 D
npm test -- src/renderer/react/features/chat/pages/ChatPage.regression.test.ts src/renderer/react/features/chat/pages/use-last-turn-actions.test.ts src/renderer/react/features/chat/pages/last-turn-revision.test.ts src/renderer/react/features/chat/pages/session-snapshot.test.ts src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts

# 施工包 E
npm test -- src/renderer/react/features/chat/components/DesktopAsrButton.test.ts src/renderer/react/features/chat/components/desktop-asr-controller.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts src/renderer/react/features/chat/pages/ChatPage.regression.test.ts
```

包含拟新增测试文件的命令，在对应施工包完成创建后执行。

### 验证命令 3：模块、类型与构建

```powershell
npm test -- src/renderer/react/features/chat src/main/chat src/main/chats src/main/asr
npm run check:renderer
npm run check:storage-boundary
npm run build:main
npm run build:preload
npm run build:renderer
git diff --check
```

最终整体验证：

```powershell
npm test
```

命令依据：`package.json:156–194`。不增加新的检查入口；全部测试沿用当前配置，不修改 CI 策略。现有归档报告由 `scripts/testing/archive-reporter.mjs` 输出 `[test-archive]` 路径，应记录退出码、提交、失败和显式跳过原因。

### 验证命令 4：真机启动与隔离

后续执行人先创建一个**全新、空白、仓库之外且不与正式 AppData 重叠**的验收根目录，再启动：

```powershell
$env:FIREFLY_ISOLATION_ROOT = '<本轮全新验收根目录的绝对路径>'
npm run dev
```

`npm run dev` 使用现有 development 启动器；数据应落在该根目录下的 `Firefly-development`，依据 `launch-electron.mjs`、`resolveRuntimeProfile`。

开始交互前确认实际数据、session 和日志路径均属于隔离根目录。模型、ASR 配置在新环境中重新设置，不从旧用户目录导入。完成后关闭应用并移除本次终端环境变量：

```powershell
Remove-Item Env:FIREFLY_ISOLATION_ROOT
```

开发档案验收不能替代正式包的新数据目录验收；正式包验收必须等待已定 `%APPDATA%\Firefly-1.2.0` 目录契约在启动与存储主题落地。

## 回滚方案

| 风险 | 控制与回退 |
| --- | --- |
| 基线与分支最新提交不同 | 实施前重新盘点差异；记录最终 SHA，不跨提交复用通过结论。 |
| 把外部规则当作产品需求 | 对语音、附件、终态、计划和审批归属逐项写明差异；未决行为不擅自改实现。 |
| 页面测试 mock 掉关键链路 | 新组合测试保留真实页面、队列和控制器；网络及 IPC 使用替身，持久化另用真实临时文件验证。 |
| 测试只断言保存调用，漏掉重启问题 | 同时覆盖实际文件重载和真机重启；不将“函数调用成功”当成数据可恢复。 |
| 终态与迟到事件交错 | 测重复终态、旧 run、旧计划、旧会话打开结果及延迟写入；同时检查禁止副作用。 |
| 测试接触旧数据 | 所有 fixture 新建，启动采用全新隔离目录；正式目录未隔离前不进行正式包验收。 |
| 外部服务不稳定 | 单元测试使用可预测替身；真机依赖不可用明确阻塞，不放宽断言或延长全局阈值。 |
| 证据泄露凭据或私人内容 | 使用合成会话与测试工作区；报告、截图、录屏在合入前脱敏。 |

各施工包单独合入，测试与文档可独立回退。若追加生产修复，其修复与复现测试放在同一独立变更中；回退修复不删除失败证据、不削弱原有断言。不得通过清空历史、取消审批或恢复旧数据目录解决回归失败。

### 工作量估计（按施工包）

按一名熟悉仓库的工程师估算，不含等待服务、负责人决策和新增功能实现。

| 施工包 | 估计 | 交付 |
| --- | --- | --- |
| A：清单、运行与持久化基线 | 1.5–2 人日 | 回归文档、三模式与终态测试、真实重载验证 |
| B：恢复、接管与队列组合 | 2–3 人日 | 页面组合测试、并发与恢复证据 |
| C：审批、选择卡与计划 | 1.5–2.5 人日 | 卡片结算、计划身份和批准派发测试 |
| D：会话、编辑、Todo 与上下文 | 1–1.5 人日 | 页面切换及状态隔离测试 |
| E：听写与附件 | 1.5–2 人日 | 权限、异步归属、附件边界测试 |
| F：完整回归与归档 | 1–2 人日 | 全部测试报告、三模式真机记录、未验证项 |
| G：未知 run 审批归属修复 | 原估算外，按根因另估 | 独立修复、归属测试及页面隔离证据 |
| **A–F 合计** | **8.5–13 人日** | **可重复执行且证据边界清楚的 ChatPage 回归清单** |

已复现的生产缺陷另按根因估算。TTS、语音自动提交、正式目录策略或审批归属规则的功能改造不包含在上述工作量中。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

仍真正未决的项（原推荐已明确保留，不重新询问已定结论）：

- 无 run ID 的合法审批请求的归属规则；已携带未知 run 不回退当前会话已定，见 G1。
- 同一批准端到端幂等已定；C7 核对事件是否具有稳定批准身份，若现有字段不足，具体契约变更需确认，不能臆造标识。
- Chat 事件监听与完整计划面板差异的后续产品行为；本主题先验现有监听，完整计划交互以 Code 为准，Work 不启用已定。扩大 Chat 面板范围另立需求。
