# Firefly-Agent 1.2.0 施工计划：会话可靠性——幂等接纳、终态、恢复与历史回放

## 1. 目标

用户在 Chat、Work、Code 中发送消息后，即使发生重复 IPC、界面刷新、回执丢失或应用崩溃，也能看到已经保存的输入和真实运行结果。同一个请求的重试返回原运行回执；停止、重载和恢复不会悄悄再次请求模型。用户发送“继续”或新的要求时，系统使用已提交历史、待办和安全状态启动新运行。

工具执行保留可核对的开始记录和成功回执。结果未知的外部操作不会因为重启、更换工具调用 ID、编辑消息或重新生成而被自动重复执行。切换模型协议、厂商、模型、端点或凭证后，通用历史保持连续，专有推理数据仅向匹配来源回放。历史压缩保留审计事实，展示更新失败不应让有效会话永久无法继续。

本计划只规定后续施工，不执行代码、配置、数据、Git 或文件修改。以下新增文件、类型、错误码和 IPC 字段均为**拟新增契约**。实现范围限定为 1.2.0 新数据目录，不读取、不回填、不迁移 1.1.x 用户数据。

## 2. 现状

### 2.1 核对基线与证据边界

- 实际 HEAD 为 `c991111efa68087b9d625868179c03fea1b83e14`；工作树干净。
- 当前工作树为 detached HEAD；本地 `dev/firefly-1.2.0` 指向同一提交。施工前应由执行者重新核对实际工作树，不把本次状态沿用为届时状态。
- 已完整读取 `AGENTS.md`，包括“修改与验证”“测试断言写法”；模块归属按 `README.md` 的“各层代码位置”“项目结构”执行。
- 本次证据为源码、现有测试内容及脚本核对；没有运行测试、构建、真实模型请求或图形界面验收。现有测试不能据此标为本次通过。
- 历史后端可靠性计划涉及调度器落盘、取消和清理边界，应保留其约束；它不是本主题已经完成的证明。证据：`docs/superpowers/plans/2026-10-18-backend-reliability.md` 的 Constraints、Task 1–3。

### 2.2 已有能力、实际差距与施工取舍

| 项目 | Firefly 当前证据 | 结论与施工范围 |
|---|---|---|
| 三种会话模式 | `src/shared/chat-types.ts` 的 `ConversationMode`；`src/main/chats/chats-store.ts` 的 `validMode` | 按 `chat / work / code` 验收，不扩充模式。 |
| 会话轨迹、快照和串行追加 | `src/main/orchestrator/conversation-transcript-store.ts` 的 `append`、`checkpoint`、`enqueue`、`loadState` | 已有，不重建第二套轨迹语义；替换持久化边界时保留条目身份、顺序和 Main 守卫。 |
| 条目幂等 | 同文件 `append`：普通同 `entryId` 记录主要检查 `kind` 后返回；用户次级键使用 `sameSemanticContent`；受控助手有额外校验 | 需要补全普通条目的内容比较。不得把同键不同内容吸收为成功。 |
| 写入持久性 | 同文件 `append` 的 `write`：普通追加使用 `appendFile`，`sWrite` 才调用 `syncJsonl` | 文件头注释不能证明全部权威写入已同步。接纳、工具开始、结果和终态需要明确提交保证。 |
| 请求、队列、用户条目和运行接纳 | `src/main/chats/chats-store.ts` 的 `claimPendingMessage` 将队首提升到会话 JSON；`src/main/chats/chats-ipc.ts:500` 起另行处理认领；`src/main/chat/agui-bridge.ts:457` 调用 `prepareTranscriptDispatch`；`harness/adapter/run-preparation.ts` 的 `store.create` 再创建运行 | 当前跨多个提交点，没有同库原子接纳。属于主要施工项。 |
| 残留认领 | `src/renderer/react/features/chat/pages/pending-queue-flow.ts` 的 `resumePendingDispatch` 在未判为已派发时调用 `startClaimedRun` | 确认需要取消恢复自动续派；必须同时保留原输入，不能只删除认领记录。 |
| 读取与恢复 | `src/main/chats/chats-ipc.ts` 的 `CHATS_GET` 读取并投影，没有盘点所暗示的统一迁移恢复入口；但 `conversation-transcript-store.ts` 的 `loadState` 会截断损坏尾行 | 不新建已经不存在的迁移路径。仍需做到应用层读取不执行修复、恢复、模型或工具调用。 |
| 正式消息与展示分离 | `src/main/orchestrator/chat-loop.ts:209–210` 提交 canonical assistant；`harness/firefly-harness.ts:119` 提交工具声明；`src/renderer/react/features/chat/pages/run/AgentRunController.ts` 的 `checkpointRun`、`writeCheckpoint` 保存展示 | 已有分层，但展示与正式消息仍存在多处写入。不能照搬不存在的 `presentation_patch` 协议，需基于现有展示保存接口改造。 |
| 工具声明与结果提交顺序 | `harness/firefly-harness.ts:119`；`harness/tool-round.ts:97`；`transcript-sink.ts` 的 `appendAssistant`、`appendToolResult` | 已有声明先提交、结果挂载声明的能力，保留并补故障测试，不作为新功能重写。 |
| 同会话互斥、接管、单终态 | `src/main/chat/agui-bridge.ts` 的 `runsByConversation`、`releaseSessionGuardEntry`、接管循环、`RunSettlementGate`；`run-settlement.ts` 的 `trySettle` | 已实现主要机制。保留，不为本主题强制拆完整桥接层。 |
| 既有竞态测试 | `src/main/chat/agui-bridge.test.ts` 已覆盖同 tick 竞争、迟到取消、接管等待、同步完成、重复终态、终态与渲染保存共同确认 | 从“新增全部守卫和测试”中剔除；只扩展持久化接纳、失败和重启交叉窗口。 |
| Harness 终态顺序与 signal | `src/main/orchestrator/harness-adapter.ts` 的 `markTerminal → finalizeReview → completePlanRun`；`harness-adapter-characterization.test.ts`；`harness-adapter-cancel.test.ts` | 已有顺序及 signal 身份测试，保留。补异常路径和持久化失败，不重复适配器拆分工程。 |
| 中断原因 | `conversation-transcript-types.ts:135` 的 interruption 只接受 `user_cancel`；`harness-adapter.ts` 主要在取消时调用 `closeInterruption` | 缺少统一的技术失败、超时、崩溃边界和下一轮提示。 |
| 当前恢复 | `harness/run-recovery.ts` 的 `prepareHarnessRecovery`；`harness/adapter/run-preparation.ts` 仅在 `resumeFromRunId` 存在时加载恢复 state/cache | 普通新消息与显式恢复尚未统一。`build-options.ts:411` 的未决副作用文字提示不能代替执行层 `initialState`。 |
| 孤儿工具记录 | `harness/run-recovery.ts` 仅遍历 `declared.values()` 合成结果并推导未决副作用 | 已避免为未声明调用直接补结果；未声明但已开始的危险记录仍需独立安全留痕。 |
| 运行存储 | `harness/run-store.ts` 的 `HarnessRunSession` 为 schema 1，保存完整 messages/state/cache；`initialize` 按索引识别 running 并转 interrupted | 完整快照和索引仍参与恢复。替代安全事实接通前不能删除这些依赖。 |
| 工具账本 | `src/main/orchestrator/execution-ledger.ts` 的 `ExecutionLedger` 使用两个 `Map`；`execute` 在外部执行返回后才缓存成功 | 不具备跨重启成功回执，且相同调用并发进入时没有共享在途结果。需要持久化和并发唯一执行者。 |
| 未决操作守卫与授权 | `harness/tool-dispatcher.ts` 调用 `findBlockingUncertainEffect`；`harness/builtin-tools.ts` 的 `executeConfirmUncertainEffect` 在允许后调用 `resolveUncertainEffect` | 拦截机制已有，保留。当前移除未决项不能证明授权只消费一次，需要持久化授权及原子消费。 |
| 压缩 | `conversation-transcript-types.ts:139` 定义 `compaction_checkpoint`；`conversation-transcript-store.ts:228` 是物化快照；`conversation-transcript-context.ts` 的 `materializeTranscript` 未处理压缩条目；`harness/compaction.ts` 的 `compressForAgentLoop` 返回内存替换历史 | 类型、快照和运行内压缩不等于会话级压缩及审计归档协议，仍需施工。 |
| 渠道历史 | `src/main/channels/dispatcher.ts` 在 memory 开启时不读取 prior history，其他路径仍调用 `resolvePriorMessages(context, 16)`；`channels/bootstrap.ts` 的 `run` 分别构造 memory 和普通入口 | 不能宣称全入口已贯通。需统一接纳、会话身份和权威历史，保留现有渠道授权。 |
| 协议回放 | `vendors/types.ts` 的 `ChatMessage.rawAssistant` 为 `unknown`；`anthropic-adapter.ts` 的 `isReplayableAssistantContent`；`responses-adapter.ts` 的 `replayableOutputItems` | 已有异构形状检查及降级，剔除“完全没有异构回放防护”的施工项；缺少完整来源绑定和版本化副本。 |
| Responses 降级 | `vendors/responses-adapter.ts` 的 `toWireInput` 为 assistant 文本构造 `input_text` | 静态确认需要修改编码；严格服务端表现尚未复测。 |
| Responses 流结束 | `vendors/sdk-stream/runtime.ts:168–185` 在缺少 terminal 时仍可 `finalize` 并返回成功 | 纳入终态可靠性：不能把缺终态的部分输出提交为成功历史。 |
| 原生历史契约 | `src/main/memory-sources/native-history-provider.ts:31`、`:70–72` 固定读取轨迹文件对；`native/src/history_read.rs` 的历史文件访问白名单；`memory-context/conversation-transcript-adapter.ts` 使用读租约 | 数据库存储切换必须同时处理原生读取、快照身份和失效校验，不能只替换 Store。 |
| 数据目录与 CI | `startup/runtime-profile.ts` 的 production 路径仍为 `Firefly`；`storage/storage-context.ts` 将 dataRoot 绑定 userData；`.github/workflows/test.yml:80–103` 已配置全量测试 | 需明确 1.2.0 新目录。CI 全量测试已有，不重复新增，也不修改阈值。 |

## 3. 设计

### 3.1 总体方案与边界

推荐采用**独立会话数据库、单写入后台线程、领域事务接口**。会话元信息、输入请求、权威轨迹、运行接纳和工具回执放入同一数据库；附件及大型工具输出继续保存文件引用。现有记忆数据库保持自己的职责，不把它与会话库之间的操作宣称为一个事务。

选择理由：继续以多个 JSON/JSONL 文件分别提交，无法直接满足“队列消费、用户事实、运行关联、请求回执同事务”的要求。自行实现跨文件提交日志会增加恢复协议。本方案复用项目已有 `node:sqlite` 和 Worker 使用经验，证据为 `src/main/memory-context/transcript-ledger.ts`、`src/main/memory-core/worker-client.ts`。

拟使用 `<StorageContext.dataRoot>/firefly-conversations.sqlite`。设置 WAL、`synchronous=FULL`、外键，写事务显式开始、提交和回滚；事务内不等待模型、外部工具、审批或文件处理。同步 SQLite 调用放在后台线程。依据：[Node.js 24 SQLite 接口](https://nodejs.org/download/release/v24.11.0/docs/api/sqlite.html)、[SQLite 事务规则](https://sqlite.org/lang_transaction.html)、[同步设置](https://sqlite.org/pragma.html#pragma_synchronous)。这些资料不代替 Firefly 所用 Electron 构建产物的运行验收。

施工中先以依赖注入接入测试；在所有写入者、恢复和原生读取完成前，不启用生产新后端。最终启用时，一个会话只有一个权威写入后端。

### 3.2 拟新增数据结构

数据库表使用 Firefly 自有命名：

| 表 | 主要字段与约束 |
|---|---|
| `firefly_sessions` | 会话 ID、现有元信息、模式、工作区绑定、下一序号、活动分支修订、删除状态。 |
| `firefly_input_requests` | `(sessionId, requestId)` 唯一；输入类别、用户轮次及修订、规范化意图、冻结配置身份、排队顺序、处理状态、原接纳回执。 |
| `firefly_run_records` | runId 唯一、请求关联、模式、状态、终态及安全原因码；每会话至多一个占用中的运行。 |
| `firefly_transcript_entries` | 保留 `TranscriptEntry` 信封；`(sessionId, id)`、`(sessionId, seq)` 唯一；用户修订另有唯一约束。 |
| `firefly_tool_receipts` | `(sessionId, logicalInvocationId)` 唯一；所属声明、规范化调用事实、执行状态、成功结果引用、未决副作用身份。 |
| `firefly_repeat_grants` | 授权 ID、未决操作 ID、参数指纹、适用范围、已消费调用、消费时间；只能消费一次。 |
| `firefly_display_updates` | 消息 ID、更新身份、修订和展示增量；与权威事实分开读取、分类报错。 |
| `firefly_schema_versions` | 仅管理 1.2.0 新库结构升级，不导入旧版用户目录。 |

规范化比较规则：

- 忽略对象键顺序；保留数组顺序和具有业务意义的空值。
- 用户请求比较正文、稳定附件元数据、操作类别、锚点、修订和冻结配置身份。
- 接纳重试不得重新读取设置后改变同一请求的意图。
- 同请求重复返回相同 `requestId / runId / userTurnId / assistantTurnId`；完成后返回原结果引用。
- 同条目不同内容、同用户修订不同内容、同工具身份不同实参均拒绝覆盖。
- 时间、序号和本次传输信息不作为用户输入等价性的依据。
- 压缩不能删除仍用于幂等比较的事实和回执。
- 诊断只记录安全错误码、身份摘要、序号和阶段，不记录正文、密钥、附件内容或工具敏感参数。

新增事件在 `TranscriptEntry` 中明确建模，建议为：

- `tool_dispatch`：工具真正派发前提交的开始事实。
- `todo_checkpoint`：当前待办集合及所属任务分支。
- `effect_decision`：已核实结果或一次重复授权的事实。
- `run_boundary`：运行终态、原因及关联请求。
- 扩展现有 `compaction_checkpoint`：由仅有 `ref` 改为可验证的版本化检查点引用。

名称均为拟新增；不从展示卡片或 AG-UI 预览反推这些事实。

### 3.3 请求接纳与队列状态

新增 `ConversationAdmissionService`，所有合法入口调用：

```text
保存用户意图 queued
→ 验证 Main 授权、会话和工作区
→ 同事务：
   查询同请求回执
   检查会话占用
   提交 user 或 turn_rewind
   建立 runId 和请求关联
   将请求置为 accepted
   更新会话元信息
→ 提交
→ 返回本地接纳回执
→ 构建上下文
→ 标记模型调用开始
→ 启动模型
```

“已接纳”只表示本地提交成功，不表示远端已收到请求。

请求状态建议为 `queued / accepted / finished / rejected / awaiting_user`；运行状态增加准备阶段，终态继续向外映射现有 `FireflyRunTerminalResult`。崩溃恢复将未完成运行结算为中断，关联请求进入 `awaiting_user`，不重新生成请求或 runId。

具体规则：

1. **恢复残留认领只对账**：保留用户事实和原始意图，结束失效认领，不调用 `startClaimedRun`。
2. **当前进程明确排队的消息**：可在前一运行释放后按原顺序执行，使用原请求身份。
3. **重启遗留队列**：推荐等待用户操作后继续；不能通过打开会话间接消费。
4. **编辑与重新生成**：每次用户动作使用新 `requestId`；前者创建新用户修订，后者复用用户轮次并提交 `keep_user` 回退事实。
5. **插话**：沿用 `createRunAdjustmentPoller` 的安全注入点，将队列消费与 user 提交合并到一个事务。
6. **接纳后构建失败**：保存失败终态、释放占用、保留输入；同请求重试返回失败回执，新用户动作才能开启新运行。
7. **接纳回执丢失**：查询原回执，禁止把传输异常当作“肯定未接纳”。

Main 记忆来源授权在事务前准备，并在实际提交边界复验。保留现有 actor、来源、附件 grant、读租约及取消检查；记忆索引失败不回滚已经提交的会话事实，也不能伪造授权成功。

### 3.4 IPC 与错误范围

保留现有通道：

- `IPC.AGUI_RUN`、`IPC.AGUI_CANCEL`、`IPC.AGUI_EVENT`
- `IPC.AGUI_RUN_PERSISTED`
- `IPC.CHATS_PENDING_*`
- `IPC.HARNESS_GET_INTERRUPTED_RUN`

拟扩展：

- `AguiRunInput` 增加稳定 `requestId`。
- `AguiRunAck` 增加接纳状态、是否复用原回执及已持久化终态引用；保留现有 `success / runId`。
- 新增只读查询 `IPC.CHATS_REQUEST_GET = "chats:request-get"`，参数仅为会话和请求身份。
- 队列回执携带请求身份；`pendingCompleteDispatch` 只处理簿记，不创建运行。
- IPC 显式序列化错误 DTO，不能依赖 Electron 保留 Error 自定义字段。

拟新增错误码：

| 错误码 | 作用范围与处理 |
|---|---|
| `E_REQUEST_CONTENT_CONFLICT` | 当前请求；保留原请求和回执，不阻塞后续新请求。 |
| `E_TRANSCRIPT_CONTENT_CONFLICT` | 当前权威写入及依赖它的运行；禁止覆盖原事实。 |
| `E_DISPLAY_UPDATE_CONFLICT` | 当前展示更新；保留上一版本，权威历史有效时允许继续。 |
| `E_TOOL_RESULT_UNKNOWN` | 当前操作及匹配重放；允许解释、核对和其他安全操作。 |
| `E_CONVERSATION_INTEGRITY` | 实际损坏的会话或引用；保留数据，阻止使用损坏上下文。 |
| `E_CONVERSATION_COMMIT_UNKNOWN` | 提交结果无法确认；按请求身份查询，不自动重发。 |
| `E_MODEL_STREAM_UNFINISHED` | 模型流缺合法终态；部分文字仅作过程展示。 |

错误接入 `src/shared/run-failure.ts` 的有限词汇表，并沿用现有错误来源分类。接管忙碌错误保留现有 `SESSION_RUN_ACTIVE`、`SESSION_RUN_TAKEOVER_STUCK` 语义；只将传递方式结构化，不改变其含义。

### 3.5 终态、取消与展示

保留会话所有权和 `RunSettlementGate` 两个独立概念：

- 会话所有权回答“哪个运行仍占用会话”。
- 结算门回答“这个运行是否已经选定终态”。
- 数据库记录回答“终态是否已可靠提交”。

正常顺序：

```text
等待受管理执行停止或获得明确未决状态
→ 提交必要工具闭合、运行边界和终态
→ finalizeReview
→ 完成现有计划生命周期
→ 成功路径执行既有成功副作用
→ sticker
→ 单个 RUN_FINISHED
→ 幂等释放生命周期和会话占用
```

技术失败发送单个 `RUN_ERROR`。取消继续使用各运行自己的 AbortController，不能用 unsubscribe 冒充执行结束。持久化失败时不得发布成功、成功 toast、计划审批或完成通知。

受控 Chat 的 `SRunSettlementGate`、`assistant_settlement` 和 Main sink 身份约束继续有效；数据库提交必须承载原有确认，不允许普通终态绕过受控结算。

展示处理：

- 正式正文来自权威轨迹；运行状态来自持久化运行记录。
- reasoning、活动条目、工具卡、sticker、语音引用使用展示增量。
- 展示写失败显示降级提示，不能把已提交的成功回答改成模型失败。
- `AGUI_RUN_PERSISTED` 仍表示界面最终展示已保存；它不再承担权威执行终态的唯一证明。
- 按钮与输入框是否可用以 Main 运行占用为准，避免展示失败造成永久 loading。
- 普通裸 complete 不再凭空认定新的 1.2.0 运行成功，必须有对应持久化终态。

### 3.6 恢复、工具回执与一次授权

启动恢复作为显式阶段运行。应用层会话读取、分页读取和历史查询只读取已提交状态，不顺便修复文件、发模型请求或执行工具。首次新派发等待本会话对账完成，不等待所有会话展示修复。

| 已保存事实 | 对账结果 |
|---|---|
| 已接纳，模型开始记录不存在 | 保存“未完成、未自动发送”，释放占用，等待用户。 |
| 模型已开始，无终态 | 标记中断，保留已提交消息。 |
| 已声明工具，无开始记录 | 合成为 `not_executed`。 |
| 工具已开始，无可靠结果 | 合成为 `unknown`，危险操作进入未决集合。 |
| 成功工具结果和回执已提交 | 返回原结果，禁止再次执行。 |
| 未声明但存在危险开始记录 | 不补孤儿 tool 消息；独立保留安全记录。 |
| 终态已提交，客户端未收到 | 返回原终态。 |

工具顺序：

```text
assistant 整组声明提交
→ 权限和未决操作检查
→ 原子登记唯一执行者、开始事实、授权消费
→ 外部执行
→ 同事务提交 canonical tool_result 与成功回执
→ 对外发布结果已提交
→ 下一次模型请求
```

只缓存 terminal success；中间输出、失败和未知结果不作为成功回执。相同逻辑调用并发时等待同一个执行者；取消等待者不能取消另一个所有者的执行。

未决操作与一次授权：

- 保留现有 `toolCallFingerprint` 的类型敏感语义。
- 参数不可用时沿用按工具名保守阻断，不能用空参数指纹伪装精确匹配。
- “仍然允许一次”写入授权记录；匹配调用登记开始时，在同一事务消费。
- 两个并发调用不能消费同一授权两次。
- 授权后再次崩溃会产生新的未决操作。
- 编辑、重新生成和压缩可以改变活动任务视图，**不能抹掉已经发生的外部副作用**。待办按活动分支恢复；未决副作用按安全账本保留，直到明确核实或处理。
- 新运行只恢复待办和未决安全状态，使用新 runId、新轮数和新缓存周期，不恢复旧协程或半截模型流。
- 敏感参数和结果不新增通用缓存副本；按现有来源屏蔽规则保存必要身份、受保护引用和未知状态。

本地事务不承诺远端恰好执行一次；网络结果未知时选择保存未知状态并核对。

### 3.7 压缩、审计与原生历史读取

会话级压缩检查点包含：

- 版本、覆盖区间、来源序号和摘要；
- 当前分支及用户修订；
- 保留后缀起点；
- 可验证的摘要消息或引用；
- 待办与未决操作的引用，不能由摘要替代安全账本。

使用现有 `findSafeCutPointForRetainedTokens` 保证完整工具回合。摘要生成失败、无收益或提交失败时保留原活动历史；超预算时给明确错误，不能偷偷丢弃中段事实继续发送。

审计行首版保留在数据库，压缩只改变模型活动视图，不删除旧条目、回退事实、原始协议副本和幂等回执。归档导出采用“完整写入、校验、发布清单”；失败保留原始事实，不发布半份归档。

原生历史读取采用**提交后生成的只读导出代际**，不让原生助手直接获得数据库写权限：

1. 导出由写入或后台维护调度，读取接口不生成导出。
2. 每个代际是不可变文件集合，绑定会话、`throughSeq`、分支修订、摘要和文件身份。
3. 全部文件写完并校验后才发布代际指针。
4. 原生读取固定已发布代际，保留路径白名单、身份检查、字节预算、取消和租约。
5. 导出落后时明确报告覆盖不足；不能把旧导出称为完整当前历史。
6. Main 当前会话上下文继续读数据库；跨会话历史不足时沿用明确降级，不触发隐式导出。
7. 删除会话、撤销权限、分支变化或导出代际变化时，使相关历史凭证失效。

此项必须与 `native-history-provider` 和 `ConversationTranscriptStore` 的 held-ticket/读租约契约一起验收，不能以普通内存读取替换原生来源证明。

### 3.8 跨来源历史回放

扩展 `vendors/types.ts`，新增版本化 `AssistantReplayRecord`：

- `version`
- 协议、厂商、实际请求模型；
- 规范化实际请求端点摘要；
- Main 生成的凭证绑定摘要；
- 有序原始内容及通用消息摘要。

正文和工具调用是通用历史；专有 thinking、签名、加密推理只在全部来源维度匹配时使用。来源缺失、版本未知、内容损坏或不匹配时，投影为通用正文和工具调用，不猜测签名，不修改持久化原件。

凭证摘要不能为明文密钥，也不直接公开普通密钥哈希；使用 Main 管理的受保护绑定。端点规范化不能合并不同区域、租户、代理路径或有意义的查询参数。

保留现有适配器，不为本主题强制换 SDK：

- Responses assistant 降级采用合法助手消息形状，保留工具声明及 `call_id` 配对。
- Anthropic 降级不构造无有效签名的 thinking 块。
- 回放副本覆盖不足时使用通用事实，避免整轮消失或重复加入。
- 请求投影只产生副本；切回原来源仍能使用匹配的原始回放记录。
- Responses 流无合法终态、工具参数未完成或稀疏终态无法补齐时，按失败结算。

### 3.9 三种模式及界面表现

| 能力 | Chat | Work | Code |
|---|---|---|---|
| 幂等发送、停止、重启 | 同请求返回原回执；重启不自动续派 | 同左 | 同左 |
| 下一轮历史 | 普通聊天与启用工具的轮次连续 | 连续保留工具事实与待办 | 连续保留工具事实、待办及工作区约束 |
| 未决操作 | 有工具时执行同一安全规则；纯聊天不创建虚假工具状态 | 拦截匹配危险重复 | 文件、命令、Git 等按实际副作用分类拦截 |
| 工作区 | 不获得额外工作区权限 | 复验附件读取范围和文件版本 | 同时复验工作区绑定；不因恢复扩展 Git 权限 |
| 终态展示 | 正文与过程状态分开，保留既有 sticker 行为 | 任务状态与实际终态一致 | 保留现有 Code 不发送 sticker 的规则 |
| 回放切换 | 三协议及来源维度全部适用 | 同左，包含工具回合 | 同左，包含工具回合 |

中文文案放入 `src/renderer/react/i18n/zh-CN.json`，同步维护 `en.json` 的键集合。建议新增：

- `chatPage.requestSavedAwaitingAction`：“上次输入已保存，未自动重新发送。发送新消息或选择继续。”
- `chatPage.runInterrupted`：“上次运行未完整结束，已保留确认完成的记录。”
- `chatPage.toolResultUnknown`：“此操作的结果尚未确认，重复执行前需要核对。”
- `chatPage.displaySaveFailed`：“结果已保存，部分过程展示未能保存。”
- `chatPage.requestConflict`：“本次请求与已保存记录不一致，请重新发起。”
- `chatPage.historyUnavailable`：“会话历史暂时无法可靠读取，原数据已保留。”

沿用现有队列、接管和消息流组件，不安排无关页面重设计。

## 4. 改动清单

各步骤按依赖顺序推进；每步都应独立通过相关测试。步骤 2–7 的新后端先通过依赖注入和集成测试使用，步骤 8 才启用完整生产路径。各步执行顺序为：补行为测试、确认失败原因、实现、定向验证、审查；保留已有有效测试。

### 步骤 1：固定基线、数据隔离与既有不变量

- [ ] 修改 `src/main/startup/runtime-profile.ts`：加入明确的 1.2.0 数据命名空间，保留 production/development/test/smoke 隔离规则。
- [ ] 修改 `src/main/storage/storage-context.ts`：声明会话库及导出根目录，执行现有路径归属检查。
- [ ] 修改 `src/main/startup/runtime-profile.test.ts`、`runtime-profile-documentation.test.ts`：覆盖新目录、旧目录不访问及启动参数。
- [ ] 扩展 `src/main/chat/agui-bridge.test.ts`、`src/main/orchestrator/harness-adapter-characterization.test.ts`：固定现有互斥、终态顺序和副作用边界，不重做已通过设计。

交付：可单独使用的新目录边界及明确的现有行为基线。

### 步骤 2：会话数据库与轨迹适配

- [ ] 新增 `src/main/storage/conversation-db-contracts.ts`：后台命令、返回 DTO、结构化错误。
- [ ] 新增 `src/main/storage/conversation-db-client.ts`：Worker 生命周期、在途请求、有界等待、关闭与失败传播。
- [ ] 新增 `src/main/storage/conversation-db-worker.ts`：唯一连接、事务执行与数据库版本检查。
- [ ] 新增 `src/main/storage/conversation-db-schema.ts`：表、索引、约束和新库结构升级。
- [ ] 新增 `src/main/storage/conversation-repository.ts`：轨迹比较、序号、请求及回执事务。
- [ ] 修改 `src/main/orchestrator/conversation-transcript-store.ts`：保留公开语义及 Main guard/lease 接口，增加数据库后端适配，读取不修复数据。
- [ ] 修改 `src/main/orchestrator/conversation-transcript-types.ts`：新增事件与版本化校验。
- [ ] 新增上述模块同名测试，扩展现有 transcript store/type/settlement 测试。

交付：未启用生产的完整事务后端；临时会话使用不落磁盘的等价事务实现。

### 步骤 3：稳定请求与原子接纳

- [ ] 新增 `src/main/chats/conversation-admission.ts`：`ConversationAdmissionService`，负责接纳、原回执查询及插话事务。
- [ ] 新增 `src/shared/conversation-request.ts`：请求身份、接纳回执、错误 DTO。
- [ ] 修改 `src/shared/chat-types.ts`、`src/shared/run-terminal.ts`：请求关联及 ACK 扩展。
- [ ] 修改 `src/shared/ipc-channels.ts`、`src/preload/index.ts`：新增回执查询，透传明确 DTO。
- [ ] 修改 `src/main/chats/chats-store.ts`、`chats-ipc.ts`：队列和展示门面接入新仓储；移除新后端跨文件接纳。
- [ ] 修改 `src/main/chat/agui-bridge.ts`：验证后调用接纳服务；重复请求返回原回执，不构造第二个 Agent。
- [ ] 修改 `src/main/orchestrator/conversation-transcript-coordinator.ts`：编辑、重新生成进入接纳事务；新后端不执行 UI 历史回填。
- [ ] 修改 `src/main/chats/pending-adjustment.ts`：安全点消费与 user 条目同事务。
- [ ] 修改 `src/renderer/react/features/chat/pages/chat-page-bridge.ts`、`pending-queue-flow.ts`、`run/AgentRunController.ts`：稳定请求身份、只查询不续派、复用终态回执。
- [ ] 修改相关 renderer bridge 类型声明和现有 IPC 契约测试。

交付：新后端的桌面请求闭环；旧生产入口尚未切换。

### 步骤 4：持久化终态与展示降级

- [ ] 修改 `src/main/orchestrator/harness/run-store.ts`：接入运行仓储，终态使用条件更新，拒绝第二个不同终态。
- [ ] 修改 `src/main/orchestrator/harness-adapter.ts`、`firefly-agent.ts`、`transcript-sink.ts`：统一成功、失败、超时和取消提交边界。
- [ ] 修改 `src/main/chat/agui-bridge.ts`、`run-settlement.ts`：先确认持久化终态，再发单终态及释放。
- [ ] 修改 `src/shared/run-failure.ts`：登记新增安全错误码。
- [ ] 修改 `src/main/chats/chats-store.ts`、`chats-ipc.ts`：展示更新拥有独立身份、修订和冲突范围。
- [ ] 修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`：权威终态与展示保存分别处理，展示失败结束 loading 并保留正文。
- [ ] 修改 `src/main/plugin-host/pending-turn-lifecycle.ts`：区分执行终态与展示持久化确认，防止重复完成通知。

交付：终态提交、事件、成功副作用和界面保存的可验证顺序。

### 步骤 5：工具持久化回执、恢复与授权消费

- [ ] 修改 `src/main/orchestrator/execution-ledger.ts`：持久化回执与在途执行者合并；保留现有逻辑冲突语义。
- [ ] 修改 `src/main/orchestrator/harness/tool-dispatcher.ts`、`tool-round.ts`、`types.ts`：等待开始事实，结果与回执同事务，正确传播失败。
- [ ] 修改 `src/main/orchestrator/harness/builtin-tools.ts`、`uncertain-effect-guard.ts`：授权记录和原子消费，保留权限检查。
- [ ] 新增 `src/main/orchestrator/harness/conversation-recovery.ts`：按会话对账及下一轮恢复投影。
- [ ] 修改 `harness/run-recovery.ts`、`harness/adapter/run-preparation.ts`：统一普通新消息与显式继续，孤儿安全记录独立处理。
- [ ] 修改 `src/main/orchestrator/build-options.ts`、`firefly-agent.ts`：同时传递恢复提示和执行层安全状态。
- [ ] 修改 `src/main/orchestrator/harness-adapter.ts`：替代恢复事实接通后，停止主运行反复保存完整消息、输出和缓存。
- [ ] 保留 `TaskSessionStore`、Review 基线、独立工具输出和子任务生命周期，分别验证其读取依赖。

交付：重启不执行；用户新一轮能恢复待办，并在执行层阻止危险重复。

### 步骤 6：会话压缩、审计导出与原生读取

- [ ] 新增 `src/main/orchestrator/conversation-compaction.ts`：会话级压缩提交及活动视图。
- [ ] 修改 `conversation-transcript-context.ts`、`conversation-transcript-types.ts`：检查点、来源映射、分支及工具配对。
- [ ] 修改 `harness/compaction.ts`、`harness/firefly-harness.ts`：复用安全切点，明确压缩事实提交后才能使用。
- [ ] 新增 `src/main/storage/conversation-history-export.ts`：不可变代际、完整发布及失败保留。
- [ ] 修改 `src/main/memory-sources/native-history-provider.ts`：固定导出代际，保持预算、租约和来源证明。
- [ ] 修改 `src/main/memory-context/conversation-transcript-adapter.ts`、`main-transcript-provider.ts`、`main-default-memory.ts`：接入新头部与失效机制，保留 Main 授权边界。
- [ ] 修改 `native/src/history_read.rs` 及其契约测试：仅允许受授权导出代际，拒绝路径越界和混合代际。
- [ ] 同步修改实际消费导出结构的历史解析类型和测试，不扩大原生文件白名单。

交付：压缩后可继续、审计可追溯、原生历史不会默默读取过时来源。

### 步骤 7：版本化回放与 Responses 终态修复

- [ ] 新增 `src/main/orchestrator/vendors/history-replay.ts`：来源绑定、版本校验及纯投影。
- [ ] 修改 `vendors/types.ts`：`AssistantReplayRecord`。
- [ ] 修改 `vendors/anthropic-adapter.ts`、`responses-adapter.ts`、`openai-adapter.ts`：通过统一投影编码历史。
- [ ] 修改 `vendors/sdk-stream/runtime.ts`：终态缺失失败、稀疏输出完整性检查、保存来源明确的副本。
- [ ] 修改 `src/main/orchestrator/chat-loop.ts`、`harness/firefly-harness.ts`：在 canonical message 提交处保留来源信息。
- [ ] 修改 `src/main/settings/credential-storage.ts` 或新增相邻窄模块：受保护的回放凭证绑定，不增加明文副本。
- [ ] 扩展对应适配器、流运行时及轨迹重启测试。

交付：跨来源安全投影和缺终态不成功落盘，可独立于数据库启用验收。

### 步骤 8：全入口切换与三模式验收

- [ ] 修改 `src/main/channels/dispatcher.ts`、`bootstrap.ts`、`channel-context.ts`：统一权威历史和请求身份，去掉普通渠道的 16 条历史旁路。
- [ ] 修改 `src/main/scheduler/scheduler-runner.ts`：使用任务本次执行身份接纳，保留已批准调度和不补跑语义。
- [ ] 修改 `src/main/proactive/proactive-model.ts`、`proactive-service.ts`：区分内部决策调用与实际会话轮次；只有提交会话的轮次接入接纳。
- [ ] 修改 `src/main/application/default-dependencies.ts`、`shutdown.ts`：数据库启动、对账、全入口注入和关闭次序。
- [ ] 修改 `src/renderer/react/features/chat/pages/pending-queue-flow.ts`、`run/AgentRunController.ts` 及现有消息流组件：三模式提示、继续动作、终态回执恢复。
- [ ] 修改 `src/renderer/react/i18n/zh-CN.json`、`en.json`：新增键及中文文案。
- [ ] 新增 `src/main/chat/conversation-reliability.integration.test.ts`：全入口、三模式、重启与失败矩阵。
- [ ] 更新 `README.md`、`DEVELOPMENT.md` 的目录和恢复操作说明。
- [ ] 统一启用新后端；排除新目录上的旧 JSON writer、renderer 历史旁路及自动续派入口。

交付：完整 1.2.0 会话路径。未通过原生读取、全入口和三模式验收前，不声明本主题完成。

## 5. 测试

所有测试遵循 `AGENTS.md`：稳定结果比较完整对象或有序列表；错误断言类型或 code；失败、取消、拒绝同时断言没有不该发生的写入和调用。时间测试使用假定时器并恢复；文件和数据库使用独立临时目录，结束清理。模型、网络、审批和渠道使用可预测替身。

### 步骤 1

测试文件：

- `src/main/startup/runtime-profile.test.ts`
- `src/main/startup/runtime-profile-documentation.test.ts`
- `src/main/chat/agui-bridge.test.ts`
- `src/main/orchestrator/harness-adapter-characterization.test.ts`

用例：

1. 生产、开发、测试、smoke 启动 → 返回完整预期路径；旧版目录没有 stat/read/write 调用。
2. 隔离路径包含 junction、越界或旧目录别名 → 明确拒绝；没有目录创建、数据库打开或设置读取。
3. 同 tick 两请求、旧运行迟到释放 → 只存在一个所有者；旧释放不删除新运行。
4. 终态持久化失败 → 不 finalize Review、不完成计划、不发送成功事件。
5. 对已有重复终态、接管和 signal 用例保持原断言，不通过删测试获得通过。

### 步骤 2

测试文件：

- 新增 `src/main/storage/conversation-db-client.test.ts`
- 新增 `src/main/storage/conversation-repository.test.ts`
- 扩展 `src/main/orchestrator/conversation-transcript-store.test.ts`
- 扩展 `conversation-transcript-store-ephemeral.test.ts`
- 扩展 `conversation-transcript-settlement.test.ts`

用例：

1. 同条目顺序、并发、关闭重开后重试 → 返回完整相同条目，只增加一次序号。
2. 同键不同正文、附件、工具关联、原始协议内容 → 返回具体冲突码；原记录不变。
3. 同用户修订使用不同 entryId → 等价时复用原条目，不等价时拒绝。
4. 事务各写入点、提交、回滚故障 → 只出现完整旧状态或完整新状态，不出现半接纳。
5. Worker 在提交前后退出 → 全部在途调用得到结果或明确未知错误，无永久 Promise；未知时不重发。
6. 数据库损坏或结构版本过新 → 保留原库，拒绝写入，不创建空库替代。
7. 读会话、读轨迹、读回执 → 业务表及导出文件不变，无恢复、模型和工具调用。
8. 临时会话完成、失败、删除 → 状态契约相同，磁盘无会话正文、轨迹或导出。

### 步骤 3

测试文件：

- 新增 `src/main/chats/conversation-admission.test.ts`
- `src/main/chats/chats-pending-queue.test.ts`
- `src/main/chats/chats-ipc.test.ts`
- `src/main/chats/pending-adjustment.test.ts`
- `src/main/chat/agui-bridge.test.ts`
- `src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`
- 新增或扩展 `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`

用例：

1. 相同请求重复发送、并发 IPC、提交后 ACK 丢失 → 同 runId，同 user 修订，只构造一次 Agent。
2. 同请求 ID 改正文或锚点 → 当前请求冲突；随后新请求正常接纳，原回执不变。
3. 请求已接纳后切换模型设置，再查询原请求 → 返回原冻结身份，不重新构建或执行。
4. 认领后未启动即崩溃 → 输入重启后可见，恢复及打开会话均不调用 `agui:run`。
5. 接纳成功、`pendingCompleteDispatch` 失败、assistant 尚未出现 → 不创建第二运行。
6. 残留认领后用户发送新消息 → 上下文保留旧意图和新输入，只派发新请求。
7. 插话提交窗口撤回、编辑、取消 → 原子得到“已消费”或“仍在队列”；不得有隐藏 user 或丢失队首。
8. 重新生成、连续两次编辑、重复回执 → 最新活动修订正确，旧分支保留审计，重复回执不再次 rewind。

### 步骤 4

测试文件：

- `src/main/chat/agui-bridge.test.ts`
- `src/main/orchestrator/harness-adapter-characterization.test.ts`
- `src/main/orchestrator/harness-adapter-cancel.test.ts`
- `src/main/orchestrator/run-settlement.test.ts`
- `src/main/plugin-host/pending-turn-lifecycle.test.ts`
- `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`

用例：

1. 成功 → 严格断言“终态提交、成功副作用、sticker、唯一终态”的顺序；Code 不出现 sticker。
2. cancelled、timeout、runtime_error → 无成功副作用、成功通知或计划审批；清理和释放各一次。
3. `success → error`、`error → late success`、重复 complete、同步 complete → 一个真实终态，无幽灵 active run。
4. 终态提交挂起时取消、接管 → 不提前接纳替代运行；超时不覆盖旧所有者。
5. Review 失败 → 已提交终态不变；数据库终态失败 → 不发布成功。
6. 展示冲突、展示存储失败 → 正文与执行终态保持正确，loading 结束，新请求可发送。
7. renderer 在终态前或后报告 persisted → 不提前、不重复发布完成。
8. 受控 Chat 无 durable S 确认 → 明确失败，无成功正文和 sticker。

### 步骤 5

测试文件：

- `src/main/orchestrator/execution-ledger.test.ts`
- `src/main/orchestrator/harness/tool-dispatcher.test.ts`
- `src/main/orchestrator/harness/tool-round.test.ts`
- `src/main/orchestrator/harness/run-recovery.test.ts`
- 新增 `src/main/orchestrator/harness/conversation-recovery.test.ts`
- `src/main/orchestrator/harness/builtin-tools.test.ts`
- `src/main/orchestrator/harness/uncertain-effect-guard.test.ts`

用例：

1. 同逻辑工具调用顺序、并发、跨重启重试 → 外部执行一次，返回相同 canonical 结果；不同实参拒绝。
2. 工具中间输出或失败 → 不成为成功缓存；调用次数和回执状态完整断言。
3. assistant 声明或开始事实提交失败 → 工具零调用。
4. 外部操作已发生、结果事务失败 → 不进行下一模型调用，不重复工具；重启保留 unknown。
5. 已声明但未开始 → 仅补 `not_executed`；已开始无结果 → 补 `unknown`。
6. 未声明但有危险开始记录 → 无孤儿 tool 消息，未决安全集合有对应记录。
7. 参数损坏 → 同工具保守阻断；不同工具仍可执行，不泄露原参数。
8. 用户允许一次，两个匹配调用并发 → 一个消费成功；另一调用被拒，授权不复活。
9. 授权消费后崩溃 → 重启不再次使用授权，产生新的未决操作。
10. 用户拒绝、确认超时、signal 取消 → 无授权消费和外部执行。
11. 普通新消息和“继续” → 恢复相同待办、安全集合；新 runId、新缓存周期，不恢复旧轮数。
12. 编辑或重新生成 → 不恢复废弃分支待办，不移除实际未决副作用。

### 步骤 6

测试文件：

- 新增 `src/main/orchestrator/conversation-compaction.test.ts`
- `src/main/orchestrator/conversation-transcript-context.test.ts`
- `src/main/orchestrator/harness/compaction.test.ts`
- 新增 `src/main/storage/conversation-history-export.test.ts`
- `src/main/memory-sources/native-history-provider.test.ts`
- `src/main/memory-context/conversation-transcript-adapter.test.ts`
- `native/src/history_read.rs` 对应测试

用例：

1. 压缩切点在多工具回合内及两侧 → 无孤立调用或结果；完整有序消息列表符合预期。
2. 摘要失败、空摘要、比原文更大 → 原活动历史和审计事实不变。
3. 压缩提交前后强制退出 → 重启只看到旧边界或完整新边界，无半份检查点。
4. 压缩后重试旧请求、用户修订和工具调用 → 返回原事实，不新增运行。
5. 回退到压缩覆盖区间 → 使用正确分支或重新构建边界，不混入被替换回答。
6. 导出任一写入、校验、发布阶段失败 → 旧代际完整可读，新代际不发布，数据库不丢事实。
7. 导出落后 → 明确覆盖不足；读取不产生导出写入。
8. 混合代际、文件替换、junction 越界、授权撤销、租约过期 → 拒绝读取或提交，无跨会话泄露。
9. 删除会话后旧凭证再次使用 → 失效，不能从残留导出复活会话。

### 步骤 7

测试文件：

- 新增 `src/main/orchestrator/vendors/history-replay.test.ts`
- `src/main/orchestrator/vendors/responses-adapter.test.ts`
- `src/main/orchestrator/vendors/anthropic-adapter.test.ts`
- `src/main/orchestrator/vendors/openai-adapter.test.ts`
- `src/main/orchestrator/vendors/sdk-stream/runtime.test.ts`
- `src/main/orchestrator/conversation-transcript-context.test.ts`

用例：

1. 三协议六个切换方向，分别含纯文本和工具回合 → 正文不丢、不重复；工具 ID、参数和结果顺序正确。
2. 同来源完整匹配 → 有序重放专有内容；单独改变厂商、模型、端点、凭证任一维度 → 专有内容不进入请求。
3. 切走再切回、持久化重开 → 原回放副本未被覆盖，可再次匹配。
4. 来源未知、版本未知、损坏副本 → 仅通用事实；不猜签名，不修改历史原件。
5. Responses 无 rawAssistant 的 assistant 文本 → 请求体合法；不得出现 assistant `input_text` 块。
6. 有效项混未知项、工具覆盖不足 → 无整轮消失，无重复 function_call。
7. 流缺终态、终态失败、工具参数未闭合 → 指定错误码，无成功 assistant 提交、无工具派发。
8. 稀疏终态与增量合并 → 完整工具列表只提交一次。
9. 日志、IPC 错误、导出元数据 → 无明文密钥、专有推理密文或敏感实参泄露。

### 步骤 8

测试文件：

- 新增 `src/main/chat/conversation-reliability.integration.test.ts`
- `src/main/channels/dispatcher.test.ts`
- `src/main/channels/bootstrap.test.ts`
- `src/main/scheduler/scheduler-runner.test.ts`
- `src/main/proactive/proactive-model.test.ts`
- `src/main/proactive/proactive-state-restart.test.ts`
- `src/main/application/default-dependencies.test.ts`
- `src/main/application/shutdown.test.ts`
- 三模式相关 renderer 测试

用例：

1. Chat/Work/Code 各执行“接纳、取消或故障、重启、新输入” → 历史、终态、待办及未决集合正确；重启零模型调用。
2. 同一绑定会话桌面与渠道并发 → 共用占用约束，无双运行、历史旁路或消息重复。
3. 渠道稳定消息 ID 重复送达 → 原回执；没有稳定身份时不使用正文相同作为永久去重依据。
4. 调度同执行槽重试 → 原运行；正常新执行槽可执行；重启不额外补跑。
5. 主动任务恢复与冷却对账 → 不制造新会话意图；正常预授权触发仍有效。
6. 关闭时存在提交、导出及执行 → 先停止接纳、取消并收敛执行、等待必要提交、关闭数据库；全部在途调用结束。
7. 三模式中文错误和降级提示 → 对应状态可见，无原始异常体；英文资源键不缺失。
8. 全入口新后端启用后 → 不读取 1.1.x，不调用旧会话 writer，不用 renderer 消息替代权威历史。

## 6. 验证命令

以下为**施工时执行**的命令，本次没有运行。均基于当前 `package.json`；定向测试使用现有 `npm test` 包装器，以保留归档 reporter。

### 6.1 每步最近测试

```powershell
# 步骤 1
npm test -- src/main/startup/runtime-profile.test.ts src/main/startup/runtime-profile-documentation.test.ts src/main/chat/agui-bridge.test.ts src/main/orchestrator/harness-adapter-characterization.test.ts

# 步骤 2：新增测试文件落地后执行
npm test -- src/main/storage/conversation-db-client.test.ts src/main/storage/conversation-repository.test.ts src/main/orchestrator/conversation-transcript-store.test.ts src/main/orchestrator/conversation-transcript-store-ephemeral.test.ts src/main/orchestrator/conversation-transcript-settlement.test.ts

# 步骤 3
npm test -- src/main/chats src/renderer/react/features/chat/pages/pending-queue-flow.test.ts src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chat/agui-bridge.test.ts

# 步骤 4
npm test -- src/main/orchestrator/run-settlement.test.ts src/main/orchestrator/harness-adapter-characterization.test.ts src/main/orchestrator/harness-adapter-cancel.test.ts src/main/chat/agui-bridge.test.ts src/main/plugin-host/pending-turn-lifecycle.test.ts

# 步骤 5
npm test -- src/main/orchestrator/execution-ledger.test.ts src/main/orchestrator/harness

# 步骤 6
npm test -- src/main/orchestrator/conversation-compaction.test.ts src/main/orchestrator/conversation-transcript-context.test.ts src/main/storage/conversation-history-export.test.ts src/main/memory-sources/native-history-provider.test.ts src/main/memory-context/conversation-transcript-adapter.test.ts
cargo test --locked --manifest-path native/Cargo.toml --features history-read history_read -- --test-threads=1

# 步骤 7
npm test -- src/main/orchestrator/vendors

# 步骤 8
npm test -- src/main/chat src/main/chats src/main/channels src/main/scheduler src/main/proactive src/main/application src/renderer/react/features/chat
```

### 6.2 模块集成、类型检查与构建

涉及 Main、IPC 或 renderer 的步骤按实际影响执行：

```powershell
npm run check:storage-boundary
npm run build:main
npm run build:preload
npm run check:renderer
npm run build:renderer
```

原生历史改动另执行：

```powershell
npm run build:history-helpers
npm run verify:history-helpers
npm run test:memory-history-zero-write
```

完成全部步骤后：

```powershell
npm test
git diff --check
git status --short
```

保留当前 CI 全量测试和现有阈值；不增加检查工具、不修改超时或覆盖率要求来获得通过。新测试由现有 `vitest.config.ts` 纳入。

### 6.3 真机与构建产物验收

1. 使用新建的独立验收目录，通过现有 `FIREFLY_ISOLATION_ROOT` 和开发启动器运行；启动前核对它不指向生产或旧版目录。该目录在实际实施验收时创建。
2. 执行 `npm run dev`，分别打开 Chat、Work、Code。
3. 每种模式验证正常回复、流中停止、运行中排队、刷新、关闭重开、发送新消息。重开后保持静止，确认没有新增模型请求。
4. 使用可控本地替身分别模拟：ACK 丢失、流缺终态、展示保存失败、数据库提交失败。核对 UI 与持久化事实，不仅观察提示文字。
5. Work/Code 使用验收目录中的无害文件操作，在工具开始后结束验收应用进程；重开确认 unknown、无自动重复，再验证一次授权。
6. 使用同一测试会话切换三协议和不同来源，完成两轮文本及工具回合。真实严格服务端验证使用负责人提供的测试档案，调用次数单独记录。
7. 对构建后的 Electron 产物验证 Worker 路径、数据库打开/关闭、备份和重启；记录实际 Electron、Node、SQLite 版本。开发进程通过不能替代构建产物通过。
8. 渠道自动化使用替身。真实渠道验收仅使用专门测试账号和测试会话，不向现有联系人发送测试消息。

## 7. 风险与回退

| 风险 | 控制与回退 |
|---|---|
| 数据库切换遗漏 writer | 步骤 8 统一启用；搜索并逐个验收桌面、渠道、调度、主动任务、插话和展示入口。启用前保留旧生产路径，启用后不双写权威历史。 |
| 新目录误读旧版 | 在启动预检阶段确定新根；无自动发现、回填和迁移；测试断言旧路径零访问。 |
| SQL 提交成功但回执丢失 | 使用稳定请求身份查询；禁止生成新 ID 自动补发。 |
| Worker 退出或事务状态未知 | 结束全部在途请求，停用失效连接，重新打开并对账后服务；不盲重试写入或模型。 |
| 工具已生效但结果未提交 | 依靠开始事实保留 unknown；禁止重复执行，不将失败伪装为未执行。 |
| 展示降级吞掉执行事实 | 分类限定到派生展示；user、assistant、tool_result、授权及终态失败仍阻断依赖它们的执行。 |
| 新事件破坏 Main 记忆守卫 | 保留 held-ticket、actor、租约、撤销和来源摘要；新增数据库及原生导出交叉测试。 |
| 压缩隐藏副作用或旧分支污染 | 待办遵从活动分支；未决副作用独立保留；压缩不删除审计事实与幂等回执。 |
| 来源绑定过宽或过窄 | 默认保守降级为通用历史；记录安全分类信息，不能为提高命中率放宽凭证或端点匹配。 |
| 大历史和导出延迟 | 后台生成、不可变代际、保留预算；覆盖不足明确报告，不同步全量复制到每次读取。 |

回退规则：

- 未启用新后端前，可以分别回退尚未使用的适配和接线步骤。
- 新后端接受实际 1.2.0 数据后，不自动切回旧 JSON writer，也不删除新库重新开始。
- 应用回退必须使用兼容该数据库版本的构建；否则从明确备份恢复到另一个隔离目录，并说明备份之后的数据范围。
- 备份使用受控数据库备份接口或停写、关闭后复制完整状态；WAL 活跃时不能只复制主库文件。[SQLite WAL 文件与恢复说明](https://sqlite.org/wal.html)
- 本次实现不得包含旧版用户数据迁移工具。

## 8. 待负责人决定

| 决策 | 推荐选项 |
|---|---|
| 1.2.0 生产数据目录名称 | 推荐 `Firefly-1.2`，开发/test/smoke 使用明确对应命名空间；不沿用当前 production 的 `Firefly`。名称统一后再改启动与文档。 |
| 是否接受会话库作为本主题基础 | 推荐接受独立会话数据库与 Worker；其原子边界覆盖请求、轨迹、运行和工具回执，记忆库不参与跨库事务。 |
| 重启遗留的普通待发队列是否自动继续 | 推荐全部等待用户操作；当前进程运行期间明确排队的消息仍可正常延迟执行。 |
| 请求冲突后如何保留输入 | 推荐保留拒绝记录和原始输入，在 UI 提示重新发起；不要覆盖原请求或无限卡在队首。 |
| 缺终态的部分文字如何展示 | 推荐作为中断过程展示，正式正文留空；“继续”启动新运行，不续传旧流。 |
| 工具成功回执保存多久 | 推荐会话存续期间保留；不得随当前内存账本 TTL 淘汰跨重启去重事实。 |
| 审计历史保留策略 | 推荐 1.2.0 首版不自动裁除审计事实，仅显式删除会话时处理；容量清理另定产品规则。 |
| 原生历史导出落后时的体验 | 推荐明确展示覆盖不足，允许当前有效会话继续；不使用过时代际冒充完整历史，不在读取中补写。 |
| 回放来源变化后的专有推理 | 推荐只回放通用正文和工具事实，保留原副本供切回；不做跨账号或跨端点“尽力重放”。 |
| 真实模型和渠道验收资源 | 推荐提供独立测试档案、测试账号和有限调用预算；替身测试与真实服务结果分别记录。 |
| 发布元信息由哪个主题统一修改 | 当前 `package.json` 为 `1.1.4`；推荐由发布/工程主题统一升为 `1.2.0`，本主题提供依赖和验收结果，避免多个计划重复修改。 |

## 9. 工作量

以熟悉 Firefly 的工程师投入估算，包含实现、定向测试和一次相关审查；不包含等待产品决策、测试账号或真实服务排期。

| 步骤 | 估算 |
|---|---:|
| 1. 基线与数据隔离 | 1–2 人日 |
| 2. 会话数据库与轨迹适配 | 5–7 人日 |
| 3. 原子接纳、队列与 IPC | 5–7 人日 |
| 4. 终态及展示降级 | 3–4 人日 |
| 5. 工具回执、恢复与授权 | 6–8 人日 |
| 6. 压缩、审计与原生读取 | 5–7 人日 |
| 7. 来源回放及协议终态 | 3–5 人日 |
| 8. 全入口切换与真机验收 | 4–6 人日 |
| **合计** | **32–46 人日** |

关键路径为 **数据隔离 → 数据库 → 原子接纳 → 终态与安全恢复 → 原生读取 → 全入口启用**。协议回放步骤在共享消息类型确定后可独立推进。验收记录必须分别列出源码核对、自动化测试、构建产物、图形界面和真实服务结果，未执行项不得计为通过。