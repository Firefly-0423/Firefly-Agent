# Firefly-Agent 1.2.0 施工计划：模型错误分类、提示与重试

## 1. 目标

主模型请求失败时，用户能分清认证失败、权限不足、欠费、额度耗尽、暂时限流、服务过载、网络中断等情况，获得中文处理建议，并在详情中查看安全的状态码、厂商错误码和请求 ID。最终失败在输入区显示一条会话级错误项，对应轮次保留简短摘要。

对尚未开始响应的暂时性故障执行有限、可取消的重试，显示等待与重连状态；明确的认证、欠费、额度耗尽和参数错误直接提示处理办法。Chat、Work、Code 使用同一分类与重试策略，保留各自现有执行、权限和持久化边界。

本次交付仅为计划。未修改文件、未执行 Git 写操作，也未运行会产生构建或测试产物的命令。

## 2. 现状

### 2.1 核对基线

- 实际 HEAD 为 `c991111efa68087b9d625868179c03fea1b83e14`，与指定提交一致；工作树干净。
- `git branch --show-current` 为空，`git symbolic-ref -q --short HEAD` 返回非零，实际处于 detached HEAD，不能表述为已检出 `dev/firefly-1.2.0`。本计划不切换分支。
- 已完整读取 `AGENTS.md`，沿用“修改与验证”和“测试断言写法”的要求。
- 模块归属按 `README.md` 的“各层代码位置”和“项目结构”：厂商调用归 `src/main/orchestrator/vendors/`，记忆授权与发送边界归 `src/main/memory-context/`，事件桥归 `src/main/chat/`，共享契约归 `src/shared/`，界面归 `src/renderer/react/`。
- `package.json` 当前版本仍为 `1.1.4`；本主题不负责整仓版本号发布调整。

### 2.2 已有能力与缺口

| 项目 | Firefly 证据 | 判断与施工范围 |
|---|---|---|
| 主模型统一发送入口 | `src/main/memory-context/main-memory-runtime.ts:184`、`:234`：准备请求并调用 `dispatchPreparedModelCall` | 在现有授权发送链路接入，不另造模型客户端 |
| 请求不可变及发送前校验 | `prepared-model-call.ts` 的 `check`、`prepareModelCall`、`dispatchPreparedModelCall`；`guardSend` 接口 | 已有，保留；重试必须继续逐次校验 |
| 有限重试 | `prepared-model-call.ts:185` 起的状态集合、`:300` 起的发送循环 | 已有两次额外尝试；不重复建设基础重试，改进分类依据、预算、等待和状态呈现 |
| 服务端等待建议 | `prepared-model-call.ts` 的 `providerRetryDelayMs` | 已支持秒数及 HTTP 日期，封顶 20 秒；已有功能从新增范围剔除，仅调整策略 |
| 可取消等待 | `prepared-model-call.ts` 的 `pause`；连接异常分支仍使用普通 `setTimeout` | HTTP 状态重试已有取消能力；连接异常等待需要统一 |
| 请求静默监控 | `prepared-model-call.ts` 的 `MODEL_IDLE_DEFAULTS`、`attemptOnce` | 已有响应头和响应体静默监控，响应体任意字节重置计时；本主题不直接替换为参考文档的超时语义 |
| SDK 内置重试关闭 | `src/main/orchestrator/vendors/sdk-stream/client-config.ts` 的 `maxRetries: 0` | 已有，保留，避免重试次数相乘 |
| 通用模型错误 | `src/main/orchestrator/agent-runtime-error.ts` 的 `AgentErrorCode`、`AgentRuntimeError` | 已有内部错误码；缺安全结构化厂商诊断 |
| SDK 异常包装 | `sdk-stream/runtime.ts:209` 起的 `catch` | 大多转换为通用错误，未形成统一厂商分类对象 |
| 非流式错误 | `prepared-model-call.ts` 的 `nonStreaming` | 保留状态，但读取原始错误正文并放入内部 `cause`；需要限制读取和诊断输出 |
| 流内失败 | `sdk-stream/responses-normalizer.ts:54`；`anthropic-normalizer.ts:34` | 当前使用 `ProviderProtocolError`，厂商业务错误与协议不支持需要分开 |
| 安全终态 | `firefly-agent.ts:134` 的 `safeTerminalError`；`src/shared/run-failure.ts` 的 `publicRunFailure` | 已有有限错误码白名单，但安全厂商详情尚未贯通 |
| AG-UI 失败事件 | `src/main/chat/agui-bridge.ts:758` | 已有 `RUN_ERROR` 和一次性结算路径；在此增加可选安全字段 |
| 失败轮次摘要 | `AgentRunController.ts:243` 起的分类文案、`:738` 的 `RUN_ERROR` 分支；同目录测试 | 已有，扩展分类摘要，不重新建设失败记录 |
| 输入区容器 | `ChatComposer.tsx:402`、`:407`、`:425` | 可在 `PendingQueueDock` 与 `ff-composer-shell` 之间加入错误项 |
| 三种模式 | `agui-bridge.ts:319`、`:473`；`firefly-agent.ts:234` 起 | 接收 Chat / Work / Code；Code 映射到 Work 执行路径，Chat 有无工具两条路径 |
| 历史压缩摘要 | `harness/firefly-harness.ts:217`；`harness/harness-llm.ts:76` 的 `summarizeHistory` | 仍有独立非流式请求，不能声称统一发送入口覆盖全部摘要 |
| 运行设置 | `src/shared/timeout-types.ts`；`src/main/settings/timeout-manager.ts`；`src/renderer/settings/timeout/panel.ts` | 已有超时设置及持久化，无模型重试次数字段 |
| 数据隔离 | `src/main/startup/runtime-profile.ts:54` 起 | production 当前使用 `Firefly` 目录，不能据此认定 1.2 已具备版本隔离；须作为实施前置条件核对 |

### 2.3 厂商范围修正

以 `src/main/orchestrator/vendors/capabilities.ts` 的 `PROVIDER_CAPABILITIES` 为准，当前注册：

`minimax`、`deepseek`、`glm`、`kimi`、`qwen`、`chatgpt`、`claude`、`mimo`、`openrouter`。

外部参考文档的厂商数量不能作为 Firefly 的覆盖承诺。当前没有豆包注册项，本主题不擅自新增厂商、端点或配置标识；其专属映射列为待决定项。其他未注册厂商同样不新增适配器。

## 3. 设计

以下新增文件、类型、字段和事件名均为本计划拟定契约，并非声称仓库已存在。

### 3.1 安全失败对象

新增 `src/shared/model-failure.ts`：

- `ModelFailureCategory`：`AUTH`、`PERMISSION`、`BILLING`、`QUOTA`、`RATE_LIMIT`、`INVALID_REQUEST`、`NOT_FOUND`、`CONTEXT_LIMIT`、`PAYLOAD_TOO_LARGE`、`CONTENT_POLICY`、`CONFLICT`、`TIMEOUT`、`NETWORK`、`OVERLOADED`、`SERVER_ERROR`、`UNAVAILABLE`、`CANCELLED`、`UNKNOWN`。
- `ModelFailureInfo`：
  - `category`、`retryable`
  - `providerId`、`protocolMode`、`model`
  - 可选 `httpStatus`、`vendorCode`、`vendorType`、`requestId`、`retryAfterSeconds`
- `ModelRetryState`：
  - `phase: "waiting" | "attempting" | "cleared"`
  - `operation: "main" | "summary"`
  - `retryNumber`、`maxRetries`
  - 可选 `delayMs`、`category`

对象不携带原始异常、正文、响应头集合、请求地址、密钥、提示词或自由文本建议。中文文案由分类枚举映射到 i18n。

安全规则：

1. 主进程显式构造白名单对象，不展开 SDK 异常。
2. `httpStatus` 仅接受合法整数状态码；错误码和类型最多 128 字符，请求 ID 最多 128 字符，模型名最多 256 字符。
3. 短码采用受限字符集校验；疑似凭据、控制字符或超限字段直接丢弃，不能仅截断后当作安全值。
4. HTTP 错误体限制读取量，建议上限 64 KiB；解析失败仍保留状态码。失败体不写入聊天、活动记录或诊断日志。
5. 请求 ID 只从已知 SDK 字段和明确允许的厂商响应头提取；不显示任意头。
6. 对 renderer 收到的可选对象再次验证；畸形对象退回现有通用错误提示。
7. 官方文档入口使用本地固定白名单，不接受响应中提供的 URL。

### 3.2 分类器与优先级

新增 `src/main/orchestrator/vendors/model-error-classifier.ts`，提供纯函数：

`classifyModelFailure(input: ModelFailureInput): ModelFailureInfo`

`ModelFailureInput` 只在主进程使用，包含实际厂商、协议、模型以及受控提取的错误信号。分类顺序：

1. 本地明确取消；不生成厂商故障提示。
2. 无 HTTP 响应的已知超时、连接异常。
3. 与实际厂商、实际协议匹配的精确业务码或错误类型。
4. 厂商专属 HTTP 状态。
5. 通用 HTTP 状态。
6. 有文档依据、限定字段及限定语义的补充信号。
7. `UNKNOWN`。

HTTP 响应中的权限、额度错误不能被通用 SDK 异常类型覆盖。无新 HTTP 响应的流内失败不虚构状态码。未知端点使用通用规则，不根据 URL、模型名或错误自由文本猜厂商。

首批映射：

| Firefly 厂商标识 | 必须覆盖的规则 |
|---|---|
| `claude` | `authentication_error`、`billing_error`、`permission_error`、`invalid_request_error`、`not_found_error`、`conflict_error`、`request_too_large`、`rate_limit_error`、`api_error`、`timeout_error`、`overloaded_error` |
| `deepseek` | 400/422 参数、401 认证、402 余额、429 限流、500 内部错误、503 过载；流内未知码只保留安全诊断 |
| `kimi` | `invalid_authentication_error`、`model_not_found`、`engine_overloaded_error`、`rate_limit_reached_error`、`exceeded_current_quota_error`、`content_filter`；额度与计费无法精确分开时采用 `QUOTA` 并提示检查账户 |
| `mimo` | 400/401/402/403/404/421/500/503；429 有明确套餐额度信号时为 `QUOTA`，否则通用限流，不凭宽泛关键词判定 |
| `chatgpt` | `slow_down`、`credit_balance_exhausted`、`organization_usage_limit_exceeded`、`server_is_overloaded`，以及明确的认证、权限、参数和上下文业务码 |
| `qwen` | `InvalidApiKey`、`AccessDenied` 及明确子码、`ModelNotFound`、`model_not_supported`；精确区分 `Throttling.*`、`CommodityNotPurchased`、`PrepaidBillOverdue`；覆盖文档列出的超时与服务不可用码 |
| `glm` | 仅将外部参考文档索引中有明确映射的数字码纳入候选；正式启用前核对官方依据，未核实部分走通用规则 |
| `minimax` | 观察性业务码不作为默认精确分类依据；保留安全短码并走通用规则，避免把观察当作公开协议保证 |
| `openrouter` | 通用 HTTP / 传输规则，不把下游厂商身份当作当前可信适配器身份 |

新增 Firefly 自有映射说明，逐条记录厂商、协议、精确字段和值、分类、重试性、来源及核对日期。实施时核对实际 SDK 类型与官方资料，不在运行时查询文档。

### 3.3 重试执行与预算

优先在 `prepared-model-call.ts` 现有发送循环内改造，新增纯策略文件 `model-request-retry.ts`，不在外层反复调用已消费的 `PreparedModelCall`。

推荐策略：

- 配置 `modelRequestMaxRetries`，表示额外尝试次数，默认 **2**，范围 **0–10**；默认值待负责人决定。
- 允许自动重试：`RATE_LIMIT`、`TIMEOUT`、`NETWORK`、`OVERLOADED`、`SERVER_ERROR`、`UNAVAILABLE`。
- 其他类别默认不自动重试；`QUOTA` 即使带等待建议，也不自动循环等待账户恢复。
- 普通退避以 2 秒起步、指数增长、上限 60 秒，采用 50%–100% jitter。
- 合法 `Retry-After` 优先，不加 jitter；建议最大接受 5 分钟。若建议超过上限，停止自动重试，不能截短后提前请求。
- 等待和再次发送均受剩余运行预算约束；预算不足时停止，不多发一次请求。
- 所有等待立即响应取消；取消、授权撤销、档案变更、记忆边界拒绝均不重试。
- 保持 SDK `maxRetries: 0`。
- 每次实际发送重新执行 `check` 和 `guardSend`，保留原请求字节、鉴权及端点限制。
- 本期保留现有“成功响应体开始后不重放”的保守边界；即使尚未展示文字，也不自动重连流。至少保证文本、推理或工具调用增量出现后绝不重放。
- 失败尝试不得触发工具执行、追加 assistant 历史或重复记账。不能承诺厂商侧失败尝试不计费。

流式明确不支持时，沿用现有非流式降级。降级不是一次额外重试；流内业务失败不得误触发降级。流式和降级请求共享同一操作预算，降级后直接使用非流式方式，避免反复探测。

历史压缩摘要使用相同分类和有限等待策略，但标记为 `summary`，不冒充最终回复失败。保留现有压缩安全边界；不为接入重试绕过记忆授权发送机制。

### 3.4 运行快照与设置

沿用现有超时设置存储和 IPC：

- `TimeoutSettings` 增加 `modelRequestMaxRetries`。
- `timeout-manager.ts` 在加载、保存边界统一校验：缺失取默认；非有限值取默认；有限值取整并限制到 0–10。
- 每次运行创建不可变配置快照，禁止持有 `getTimeoutSettings()` 返回的可变对象作为运行策略。
- “运行设置”增加数字输入：“模型请求重试次数”。
- 帮助文案：“首次失败后的额外尝试次数，0 表示关闭。仅重试暂时性故障。”
- 不因切换模型档案改变全局值。

不改变现有单次超时、静默监控和整轮超时的含义；分别测试其与等待预算的关系。

### 3.5 错误与事件传递

保留现有内部 `E_MODEL_*` 错误码，不用厂商业务码替代内部码：

`厂商信号 → ModelFailureInfo → AgentRuntimeError → safeTerminalError → AgUiBridge → AgentRunController`

- `AgentRuntimeError` 增加可选安全失败信息。
- `safeTerminalError` 解包后仅保留经过验证的安全对象。
- `publicRunFailure` 的既有错误码、来源契约保持有效。
- 最终主模型失败增加 `RUN_ERROR.metadata.fireflyModelFailure`。
- 重试状态使用新增 CUSTOM 事件 `firefly.model.retry`。
- 沿用 `IPC.AGUI_EVENT`（`agui:event`），不新增错误详情查询 IPC。
- 设置沿用 `settings:get-timeout-settings`、`settings:save-timeout-settings`。
- 失败和重试事件都受当前会话、当前运行身份校验；终态之后的迟到事件丢弃。
- 重试状态是临时 UI 状态，不写入消息正文、历史、检查点或活动持久化记录。

### 3.6 三种模式与界面

| 模式 | 请求与界面行为 |
|---|---|
| Chat | 无工具 ChatLoop、有工具 Harness 均接入；等待显示于当前轮活动区；最终主模型失败显示输入区错误项 |
| Work | 每轮主模型操作独立预算；前面成功的工具结果保留；后续模型失败不能重跑已完成工具；摘要等待明确显示“正在重试上下文压缩请求” |
| Code | 沿用 Work 执行链和同一输入区组件；保留工作区、终端、文件及 Git 状态，错误提示不得暗示代码操作已回滚或可安全重复执行 |

错误项放在 `PendingQueueDock` 与 `ff-composer-shell` 之间：

- 标题：“错误提示”。
- 简短说明由分类生成，例如“账户余额或计费状态异常，请检查模型服务账户。”
- 操作：“查看详情”。
- 详情使用现有 Ant Design `Modal`，不引入新 UI 框架或组件生成器。
- 展示类别、厂商、模型、协议、可用状态码、业务码、请求 ID、处理建议和固定官方文档入口；缺失字段隐藏。
- 未知错误：“未知错误，请查看错误码并查询厂商文档。”无代码时显示“厂商未返回可识别错误码”。
- 每个会话最多一条最近失败；新一轮真正开始时清除。切换会话只显示目标会话状态。
- 轮次保留简短分类与必要错误码，不持久化原始异常。
- 重试成功、最终失败、取消、恢复会话及首次有效输出时清除重试状态。
- 错误项使用 `role="status"`、`aria-live="polite"`；弹窗支持 Escape、焦点进入与关闭后返回。

## 4. 改动清单

每步先补失败测试，再实现，最后运行该步最近测试；前置步骤合入后，后续步骤仍须能独立通过已有检查。

### 步骤一：分类契约和安全提取

- [ ] 新增 `src/shared/model-failure.ts`：安全 DTO、枚举、验证函数。
- [ ] 新增 `src/main/orchestrator/vendors/model-error-classifier.ts`：协议限定的提取和分类。
- [ ] 新增上述文件对应的 `.test.ts`。
- [ ] 新增 `docs/references/model-errors.md`：Firefly 映射、证据强弱和维护规则。

本步不改变运行行为，可单独合入。

### 步骤二：请求边界接线和安全终态

- [ ] 修改 `src/main/orchestrator/agent-runtime-error.ts`。
- [ ] 修改 `vendors/prepared-model-call.ts`：受限读取非成功响应并分类，先识别业务码再决定现有重试。
- [ ] 修改 `vendors/sdk-stream/runtime.ts`。
- [ ] 修改 `vendors/sdk-stream/responses-normalizer.ts`、`anthropic-normalizer.ts`：保留受控业务信号，区分业务失败和协议不支持。
- [ ] 修改 `firefly-agent.ts`、`src/main/chat/agui-bridge.ts`：传递安全详情，保留终态闸门。
- [ ] 修改对应测试及 `src/main/chat/agui-chat-failure.integration.test.ts`。

本步继续使用当前次数和等待参数，先修复额度类 429 被统一重试的问题。

### 步骤三：可配置重试和统一等待

- [ ] 新增 `vendors/model-request-retry.ts` 及测试。
- [ ] 修改 `prepared-model-call.ts`，替换两套等待逻辑。
- [ ] 修改 `src/shared/timeout-types.ts`、`src/main/settings/timeout-manager.ts`。
- [ ] 修改 `src/main/memory-context/main-memory-runtime.ts`：注入可信运行快照、预算和安全重试回调，保留发送权限校验。
- [ ] 修改 `firefly-agent.ts`、`src/main/chat/agui-bridge.ts`：运行快照及 CUSTOM 事件。
- [ ] 修改 `src/renderer/settings/index.html`、`timeout/dom.ts`、`timeout/panel.ts`、`i18n/zh-CN.json`。
- [ ] 修改对应测试。

### 步骤四：降级、摘要及三模式衔接

- [ ] 修改 `src/main/orchestrator/chat-loop.ts`：共享操作预算，限制图片降级触发条件。
- [ ] 修改 `src/main/orchestrator/harness/harness-llm.ts`：流式降级共享预算，摘要使用统一重试策略与超时。
- [ ] 修改 `src/main/orchestrator/harness/firefly-harness.ts`：向摘要传入运行快照、剩余预算和状态回调。
- [ ] 修改上述文件对应测试，增加 Chat / Work / Code 集成场景。

不得通过外层重跑整个 Harness 来实现模型重试。

### 步骤五：输入区提示和临时状态

- [ ] 修改 `src/renderer/react/features/chat/pages/chat-page-bridge.ts`：扩展安全事件类型。
- [ ] 修改 `pages/run/AgentRunController.ts`：校验事件、更新临时状态和轮次摘要。
- [ ] 修改 `pages/ChatPage.tsx`：按会话持有最近失败及重试状态。
- [ ] 修改 `components/ChatComposer.tsx`、`ChatComposer.css`。
- [ ] 新增 `components/ModelFailureNotice.tsx` 及测试：错误项与详情弹窗。
- [ ] 修改 `src/renderer/react/i18n/zh-CN.json`；按现有语言资源结构补充对应键，禁止界面直接展示枚举名。
- [ ] 修改 `AgentRunController.test.ts`、`ChatPage.test.ts`、`ChatComposer.test.ts`。

## 5. 测试

### 步骤一

测试文件：`src/shared/model-failure.test.ts`、`vendors/model-error-classifier.test.ts`。

- 精确业务码与 HTTP 状态冲突 → 比较完整分类对象，确认业务码优先；429 欠费不成为 `RATE_LIMIT`。
- 同一业务码出现在其他厂商或协议 → 不命中专属规则。
- DeepSeek 402/422、MiMo 421、Anthropic 类型、Kimi 类型、Qwen 业务码 → 表驱动逐项比较类别、重试性及安全字段。
- 空响应、HTML、残缺 JSON、未知码、未知状态 → 不二次抛错，不虚构业务码或状态。
- 密钥、提示词、长正文藏在错误字段或 request ID → DTO 不包含敏感内容；允许的安全字段仍完整保留。
- 字段长度、字符集、状态范围 → 测临界值两侧；未知字段不进入输出。

### 步骤二

测试文件：`prepared-model-call.test.ts`、`sdk-stream/runtime.test.ts`、两个 normalizer 对应测试、`firefly-agent.test.ts`、`agui-bridge.test.ts`、`agui-chat-failure.integration.test.ts`。

- 429 额度耗尽 → 网络仅调用一次，终态带安全 `QUOTA`，不等待、不泄露响应正文。
- 流内 `response.failed` / Anthropic error → 保留允许的业务码，不伪造 HTTP 状态，不触发“不支持流式”降级。
- 包装错误经过真实 Agent 和桥层 → 比较完整安全事件；终态仅一次。
- 用户取消、工具失败、记忆关闭失败 → 不附主模型失败对象；保留原内部错误码与来源。
- 原始异常含凭据 → 检查 IPC、日志捕获和失败摘要均无敏感原文。

### 步骤三

测试文件：`model-request-retry.test.ts`、`prepared-model-call.test.ts`、`main-memory-runtime.test.ts`、`timeout-manager.test.ts`、`renderer/settings/timeout/panel.test.ts`。

- 额外次数为 0/1/10 → 实际最多发送 1/2/11 次；预算耗尽不多发。
- 暂时错误后成功 → 成功只结算一次；失败尝试无历史追加、工具执行或重复记账。
- 鉴权、权限、欠费、额度、参数、内容过滤、未知错误 → 仅一次发送。
- 秒数、日期、非法值、过去日期及超过上限的 `Retry-After` → 断言确定等待结果和是否停止。
- jitter 与退避上下限 → 注入确定随机源、使用假定时器，测试临界点。
- 等待中取消、运行结束、授权撤销或档案变更 → 无后续网络发送；返回稳定取消或边界错误。
- 重试前忘记记忆或发送许可失效 → 再次经过 guard，拒绝后不发送旧请求。
- 运行中修改设置 → 当前运行次数不变，新运行使用新快照。
- 设置保存及重启读取 → 使用临时目录真实文件；保留 0，非法输入按约定归一，清理目录。

### 步骤四

测试文件：`chat-loop.test.ts`、`harness/harness-llm.test.ts`、对应 Harness 集成测试。

- 流式明确不支持后非流式成功 → 降级不消耗额外次数、不重复探测、不重复记账。
- 已收到文本、推理、工具调用片段或已开始成功响应体后断流 → 不重放；不执行残缺工具调用。
- Work / Code 已完成工具后下一轮模型失败 → 工具调用次数保持一次，结果保留。
- 摘要暂时失败再成功 → 原历史只在成功摘要后替换。
- 摘要最终失败或取消 → 原历史不被空摘要覆盖，不出现主模型输入区专属错误项。
- 图片请求 400 且分类非 `INVALID_REQUEST` → 不触发图片文字替代。

### 步骤五

测试文件：`AgentRunController.test.ts`、`ChatPage.test.ts`、`ModelFailureNotice.test.ts`、`ChatComposer.test.ts`。

- 当前运行最终主模型失败 → 一条错误项、正确中文建议、详情字段与对应轮次摘要。
- 重复终态、旧运行迟到事件 → 不重复记录，不覆盖新运行。
- 切换会话、新轮启动、取消、恢复 → 状态归属和清除符合设计。
- 无安全详情或畸形 metadata → 通用错误仍正常显示，无异常崩溃。
- 重试等待到成功 → 临时状态清除，持久化消息不含重试状态。
- 键盘打开和关闭弹窗 → 焦点正确恢复；缺失字段隐藏；无 raw error 文本。

所有计时测试结束后恢复真实定时器；网络、模型和系统服务使用确定替身。平台条件不足时显式跳过并写原因，不静默返回。

## 6. 验证命令

依据 `package.json`，`npm test` 调用 `scripts/testing/run-tests.mjs`，支持传入测试路径并保留测试归档 reporter。实施阶段按步骤执行，不能用历史报告代替本次结果。

```powershell
# 步骤一
npm test -- src/shared/model-failure.test.ts src/main/orchestrator/vendors/model-error-classifier.test.ts

# 步骤二
npm test -- src/main/orchestrator/vendors/prepared-model-call.test.ts src/main/orchestrator/vendors/sdk-stream src/main/orchestrator/firefly-agent.test.ts src/main/chat/agui-bridge.test.ts src/main/chat/agui-chat-failure.integration.test.ts

# 步骤三
npm test -- src/main/orchestrator/vendors/model-request-retry.test.ts src/main/orchestrator/vendors/prepared-model-call.test.ts src/main/memory-context/main-memory-runtime.test.ts src/main/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts

# 步骤四
npm test -- src/main/orchestrator/chat-loop.test.ts src/main/orchestrator/harness

# 步骤五
npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts

# 整体验证
npm run check:storage-boundary
npm run build:main
npm run build:preload
npm run check:renderer
npm run build:renderer
npm test
git diff --check
```

其中新增测试路径在对应步骤建立后执行。使用项目要求的 Node.js 24 和 npm；不新增检查工具、不降低阈值、不修改 CI 策略。

真机验收：

1. 使用已确认的 1.2 独立数据目录；开发或 smoke 档案通过现有 `FIREFLY_RUNTIME_PROFILE`、`FIREFLY_ISOLATION_ROOT` 配置。启动前确认目录与 1.1.x 分离。
2. 在实施环境运行 `npm run dev`，使用可控本地模型响应服务，依次产生 401、402、429 限流、429 额度、503、非 JSON 错误和流中断。
3. Chat 分别验证无工具和有工具路径；Work / Code 在工具完成后令下一次模型请求失败，确认无重复操作。
4. 验证等待时取消、切换会话、重新发送、设置保存及重启。
5. 检查中文错误项、弹窗键盘操作、窄窗口和主题；确认日志、历史及测试响应中的敏感哨兵值未泄露。
6. 真实厂商联通性只在负责人提供测试账户后补验，不用真实欠费、额度耗尽或高频请求制造测试故障。

本次只做只读核对，以上测试、构建和 UI 验收均未执行。

## 7. 风险与回退

- **厂商与协议误匹配**：兼容协议不代表同一厂商语义。规则同时限定实际厂商和协议；未知信号回退通用分类。
- **重试绕过授权**：不得重建、重复消费准备好的请求许可；保留每次发送前的 guard。此项失败阻止合入。
- **重复输出或外部副作用**：本期不做断流续接，响应开始后停止自动重放；禁止通过重跑整个运行来恢复模型请求。
- **错误详情泄露**：主进程与 renderer 双重白名单校验，原始正文不进入事件和历史；无法确认安全的字段直接省略。
- **等待过长**：等待受运行剩余预算约束，取消立即生效；超长服务端建议直接停止自动重试。
- **数据目录尚未隔离**：当前 production 路径未体现版本隔离。发布和真机持久化验收必须以前置隔离完成为条件，不读取或迁移 1.1.x 数据。
- **参考资料证据不足**：观察性或未复核规则不能伪装为已确认厂商协议，先保留通用分类。
- **回退方式**：运行设置设为 0 可关闭自动重试；界面可回退到现有通用失败摘要。代码按五步分组撤回，移除读取方前同步撤回新增事件发送方。新增安全字段保持可选，不需要历史数据迁移。安全脱敏修复不随体验回退一并撤销。

## 8. 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

| 决策 | 推荐选项 |
|---|---|
| 默认额外重试次数：现状为 2，外部参考文档建议 5 | 默认 2，允许 0–10；降低失败等待和重复计费风险 |
| 外部参考文档一处写所有错误都重试，验收却要求欠费和额度只调用一次 | 以精确分类决定重试；鉴权、欠费、额度、参数、内容安全和未知错误不自动重试 |
| `Retry-After` 上限由 20 秒提高到多少 | 接受不超过 5 分钟且不越过运行预算的建议；超限停止，不能提前重试 |
| 是否扩大到成功响应开始后、尚无文字时的流重连 | 本期保留响应开始后不重放，后续单独设计去重与恢复 |
| 豆包专属映射如何纳入 | 先由独立厂商接入主题确定真实标识、端点与协议，再补映射；不凭参考文档新增注册项 |
| 其他证据不足厂商如何验收 | 所有已注册厂商有通用兜底；专属映射只承诺已核实条目，单独列覆盖表 |
| 摘要最终失败是否显示同样输入区错误项 | 不显示主模型专属错误项；保留明确标注的压缩失败提示与原历史 |
| 1.2 数据目录及生产安装标识由谁负责 | 归启动与发布主题统一决定；本主题将其作为发布前置条件，不迁移 1.1.x |
| 是否增加“复制诊断信息” | 本期不增加；先交付安全详情，后续单独定义复制白名单 |

## 9. 工作量

| 步骤 | 估计 |
|---|---:|
| 一：安全契约、分类器、映射说明和表驱动测试 | 2–3 人日 |
| 二：请求边界、流内错误和安全终态接线 | 2–3 人日 |
| 三：可配置重试、取消、预算及设置 | 3–4 人日 |
| 四：降级、摘要、三模式和副作用边界 | 2–3 人日 |
| 五：输入区提示、详情和状态生命周期 | 2–3 人日 |
| 整体验证、真机验收和问题修正 | 1–2 人日 |
| **合计** | **12–18 人日** |

估算包含相关测试与文档，不包含新增厂商接入、1.2 安装数据目录改造、断流续接，以及真实厂商账户准备。