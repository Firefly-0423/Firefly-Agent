# Firefly-Agent 1.2.0 模型错误分类、提示与重试施工计划
状态：待施工
规格：无独立规格，沿用本计划已确认设计和 2026-11-12 负责人决定；权限约束见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2。

> 路径说明（2026-11-13）：主进程已按七层重组（#57、#58），本文的文件路径和符号名已换成新位置（如 `src/main/agent/loop/agent-loop.ts`、`runAgentLoop`）。`文件:行号` 里的行号仍是重组前（`39987fc`）的位置，施工时以符号名为准，并在进度文档记录实际行号。

**目标：** 主模型请求失败时，用户能分清认证失败、权限不足、欠费、额度耗尽、暂时限流、服务过载、网络中断等情况，获得中文处理建议，并在详情中查看安全的状态码、厂商错误码和请求 ID。最终失败在输入区显示一条会话级错误项，对应轮次保留简短摘要。

对尚未开始响应的暂时性故障执行有限、可取消的重试，显示等待与重连状态；明确的认证、欠费、额度耗尽和参数错误直接提示处理办法。Chat、Work、Code 使用同一分类与重试策略，保留各自现有执行、权限和持久化边界。

**架构：** 在现有授权发送链路和 prepared-model-call.ts 发送循环内加入安全分类契约、有限重试，通过 AgentRuntimeError、safeTerminalError、AgUiBridge 向 AgentRunController 传递白名单诊断和临时状态；ChatLoop、Harness、历史摘要共享策略、快照及预算，输入区复用现有组件。以下新增文件、类型、字段和事件名均为本计划拟定契约，并非声称仓库已存在。

**不改的东西：** 保留现有执行、权限和持久化边界，内部 E_MODEL_* 错误码、publicRunFailure 来源契约、既有 IPC、SDK maxRetries: 0、单次超时 / 静默监控 / 整轮超时含义；不另造模型客户端、不新增厂商适配器、不迁移 1.1.x 数据、不做断流续接，不负责整仓版本号和安装目录改造，不引入新 UI 框架或组件生成器。

## 现状

以下保留原计划历史核对快照，包括当时 HEAD、detached HEAD 和工作树描述；文件行号与符号原样保留，不表述为本次实时结论。2026-11-13 整理时分支为 `dev/firefly-1.2.0`，HEAD 为 `e945bf44472f41c852612ecbd9d4e26eda382fef`。

### 1. 核对基线

- 实际 HEAD 为 `c991111efa68087b9d625868179c03fea1b83e14`，与指定提交一致；工作树干净。
- `git branch --show-current` 为空，`git symbolic-ref -q --short HEAD` 返回非零，实际处于 detached HEAD，不能表述为已检出 `dev/firefly-1.2.0`。本计划不切换分支。
- 已完整读取 `AGENTS.md`，沿用“修改与验证”和“测试断言写法”的要求。
- 模块归属按 `README.md` 的“各层代码位置”和“项目结构”：厂商调用归 `src/main/model/providers/`，记忆授权与发送边界归 `src/main/memory/context/`，事件桥归 `src/main/features/chat/`，共享契约归 `src/shared/`，界面归 `src/renderer/react/`。
- `package.json` 当前版本仍为 `1.1.4`；本主题不负责整仓版本号发布调整。

### 2. 已有能力与缺口

| 项目 | Firefly 证据 | 判断与施工范围 |
|---|---|---|
| 主模型统一发送入口 | `src/main/agent/memory-runtime/main-memory-runtime.ts:184`、`:234`：准备请求并调用 `dispatchPreparedModelCall` | 在现有授权发送链路接入，不另造模型客户端 |
| 请求不可变及发送前校验 | `prepared-model-call.ts` 的 `check`、`prepareModelCall`、`dispatchPreparedModelCall`；`guardSend` 接口 | 已有，保留；重试必须继续逐次校验 |
| 有限重试 | `prepared-model-call.ts:185` 起的状态集合、`:300` 起的发送循环 | 已有两次额外尝试；不重复建设基础重试，改进分类依据、预算、等待和状态呈现 |
| 服务端等待建议 | `prepared-model-call.ts` 的 `providerRetryDelayMs` | 已支持秒数及 HTTP 日期，封顶 20 秒；已有功能从新增范围剔除，仅调整策略 |
| 可取消等待 | `prepared-model-call.ts` 的 `pause`；连接异常分支仍使用普通 `setTimeout` | HTTP 状态重试已有取消能力；连接异常等待需要统一 |
| 请求静默监控 | `prepared-model-call.ts` 的 `MODEL_IDLE_DEFAULTS`、`attemptOnce` | 已有响应头和响应体静默监控，响应体任意字节重置计时；本主题不直接替换为参考文档的超时语义 |
| SDK 内置重试关闭 | `src/main/model/providers/sdk-stream/client-config.ts` 的 `maxRetries: 0` | 已有，保留，避免重试次数相乘 |
| 通用模型错误 | `src/main/model/errors/agent-runtime-error.ts` 的 `AgentErrorCode`、`AgentRuntimeError` | 已有内部错误码；缺安全结构化厂商诊断 |
| SDK 异常包装 | `model/providers/sdk-stream/runtime.ts:209` 起的 `catch` | 大多转换为通用错误，未形成统一厂商分类对象 |
| 非流式错误 | `prepared-model-call.ts` 的 `nonStreaming` | 保留状态，但读取原始错误正文并放入内部 `cause`；需要限制读取和诊断输出 |
| 流内失败 | `model/providers/sdk-stream/responses-normalizer.ts:54`；`anthropic-normalizer.ts:34` | 当前使用 `ProviderProtocolError`，厂商业务错误与协议不支持需要分开 |
| 安全终态 | `firefly-agent.ts:134` 的 `safeTerminalError`；`src/shared/run-failure.ts` 的 `publicRunFailure` | 已有有限错误码白名单，但安全厂商详情尚未贯通 |
| AG-UI 失败事件 | `src/main/features/chat/agui-bridge.ts:758` | 已有 `RUN_ERROR` 和一次性结算路径；在此增加可选安全字段 |
| 失败轮次摘要 | `AgentRunController.ts:243` 起的分类文案、`:738` 的 `RUN_ERROR` 分支；同目录测试 | 已有，扩展分类摘要，不重新建设失败记录 |
| 输入区容器 | `ChatComposer.tsx:402`、`:407`、`:425` | 可在 `PendingQueueDock` 与 `ff-composer-shell` 之间加入错误项 |
| 三种模式 | `agui-bridge.ts:319`、`:473`；`firefly-agent.ts:234` 起 | 接收 Chat / Work / Code；Code 映射到 Work 执行路径，Chat 有无工具两条路径 |
| 历史压缩摘要 | `agent/loop/agent-loop.ts:217`；`agent/loop/agent-loop-llm.ts:76` 的 `summarizeHistory` | 仍有独立非流式请求，不能声称统一发送入口覆盖全部摘要 |
| 运行设置 | `src/shared/timeout-types.ts`；`src/main/platform/settings/timeout-manager.ts`；`src/renderer/settings/timeout/panel.ts` | 已有超时设置及持久化，无模型重试次数字段 |
| 数据隔离 | `src/main/base/identity/runtime-profile.ts:54` 起 | production 当前使用 `Firefly` 目录，不能据此认定 1.2 已具备版本隔离；须作为实施前置条件核对 |

### 3. 厂商范围修正

以 `src/main/model/providers/capabilities.ts` 的 `PROVIDER_CAPABILITIES` 为准，当前注册：

`minimax`、`deepseek`、`glm`、`kimi`、`qwen`、`chatgpt`、`claude`、`mimo`、`openrouter`。

外部参考文档的厂商数量不能作为 Firefly 的覆盖承诺。当前没有豆包注册项，本主题不擅自新增厂商、端点或配置标识；其专属映射按负责人决定交由独立厂商接入主题，真实标识、端点与协议确认后再补映射。其他未注册厂商同样不新增适配器。

## 全局约束

- 每包一个 PR，按 `docs/contributing/development-workflow.md` §5 控制颗粒度。每步先补失败测试，再实现，最后运行最近测试；前置包合入后，后续包仍须独立通过已有检查。
- 沿用 `AGENTS.md` 测试断言写法 12 条：完整对象 / 有序列表优先；稳定错误码及来源明确断言；拒绝、取消、失败同时断言无写入、调用或泄露；同契约表驱动，阈值测临界点及两侧。
- 所有计时测试结束后恢复真实定时器；网络、模型和系统服务使用确定替身。平台条件不足时显式跳过并写原因，不静默返回。
- 文件系统行为使用独立临时目录真实文件，覆盖越界和错误路径，结束后清理；不读取或迁移 1.1.x 数据。
- 用户可选权限只有只读 `read-only`、请求审批 `per-action`、完全访问 `full` 三档；1.2.0 删除旧值 `project-read-only` 和 `scoped`，不新增旧档位兼容或迁移路径。删除由权限主题负责，本主题按三档验证逐次发送校验。
- 1.2.0 正式数据目录已定为 `%APPDATA%\Firefly-1.2.0`；启动与发布主题完成隔离后，方可发布和开展真机持久化验收。
- 使用项目要求的 Node.js 24 和 npm；不新增检查工具、不降低阈值、不修改 CI 策略，不新增运行时依赖。

## 文件清单

以下列后续施工文件，不是计划阶段改动的源码。新测试在所属包建立后执行；相同文件可在多包中逐步演进。新增 / 修改以本次实际文件是否存在划分。

### 新建

- `src/shared/model-failure.ts`（施工包 A）
- `src/main/model/providers/model-error-classifier.ts`（施工包 A）
- `docs/references/model-errors.md`（施工包 A）
- `src/shared/model-failure.test.ts`（施工包 A）
- `src/main/model/providers/model-error-classifier.test.ts`（施工包 A）
- `src/main/model/providers/model-request-retry.ts`（施工包 C）
- `src/main/model/providers/model-request-retry.test.ts`（施工包 C）
- `src/renderer/react/features/chat/components/ModelFailureNotice.tsx`（施工包 E）
- `src/renderer/react/features/chat/components/ModelFailureNotice.test.ts`（施工包 E）

### 修改

- `src/main/model/errors/agent-runtime-error.ts`（施工包 B）
- `src/main/model/providers/prepared-model-call.ts`（施工包 B、C）
- `src/main/model/providers/sdk-stream/runtime.ts`（施工包 B）
- `src/main/model/providers/sdk-stream/responses-normalizer.ts`（施工包 B）
- `src/main/model/providers/sdk-stream/anthropic-normalizer.ts`（施工包 B）
- `src/main/agent/runtime/firefly-agent.ts`（施工包 B、C）
- `src/main/features/chat/agui-bridge.ts`（施工包 B、C）
- `src/main/model/providers/prepared-model-call.test.ts`（施工包 B、C）
- `src/main/model/providers/sdk-stream/runtime.test.ts`（施工包 B）
- `src/main/model/providers/sdk-stream/responses-normalizer.test.ts`（施工包 B）
- `src/main/model/providers/sdk-stream/anthropic-normalizer.test.ts`（施工包 B）
- `src/main/agent/runtime/firefly-agent.test.ts`（施工包 B）
- `src/main/features/chat/agui-bridge.test.ts`（施工包 B）
- `src/main/features/chat/agui-chat-failure.integration.test.ts`（施工包 B）
- `src/shared/timeout-types.ts`（施工包 C）
- `src/main/platform/settings/timeout-manager.ts`（施工包 C）
- `src/main/agent/memory-runtime/main-memory-runtime.ts`（施工包 C）
- `src/renderer/settings/index.html`（施工包 C）
- `src/renderer/settings/timeout/dom.ts`（施工包 C）
- `src/renderer/settings/timeout/panel.ts`（施工包 C）
- `src/renderer/settings/i18n/zh-CN.json`（施工包 C）
- `src/main/agent/memory-runtime/main-memory-runtime.test.ts`（施工包 C）
- `src/main/platform/settings/timeout-manager.test.ts`（施工包 C）
- `src/renderer/settings/timeout/panel.test.ts`（施工包 C）
- `src/main/agent/runtime/chat-loop.ts`（施工包 D）
- `src/main/agent/loop/agent-loop-llm.ts`（施工包 D）
- `src/main/agent/loop/agent-loop.ts`（施工包 D）
- `src/main/agent/runtime/chat-loop.test.ts`（施工包 D）
- `src/main/agent/loop/agent-loop-llm.test.ts`（施工包 D）
- `src/main/agent/loop/agent-loop.test.ts`（施工包 D）
- `src/main/agent/loop/compaction.test.ts`（施工包 D）
- `src/renderer/react/features/chat/pages/chat-page-bridge.ts`（施工包 E）
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`（施工包 E）
- `src/renderer/react/features/chat/pages/ChatPage.tsx`（施工包 E）
- `src/renderer/react/features/chat/components/ChatComposer.tsx`（施工包 E）
- `src/renderer/react/features/chat/components/ChatComposer.css`（施工包 E）
- `src/renderer/react/i18n/zh-CN.json`（施工包 E）
- `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`（施工包 E）
- `src/renderer/react/features/chat/pages/ChatPage.test.ts`（施工包 E）
- `src/renderer/react/features/chat/components/ChatComposer.test.ts`（施工包 E）

## 施工包

建议合并顺序：A → B → C → D → E。每包一个 PR，测试与实现同包。文件数按去重路径统计，规模判断不含测试；每包先跑最近测试，再按影响扩大到模块、类型检查和构建。完整命令及真机步骤见全量验收清单。

### 工作量估计（按包）

| 施工包 | 估计 |
|---|---:|
| A：安全契约、分类器、映射说明和表驱动测试 | 2–3 人日 |
| B：请求边界、流内错误和安全终态接线 | 2–3 人日 |
| C：可配置重试、取消、预算及设置 | 3–4 人日 |
| D：降级、摘要、三模式和副作用边界 | 2–3 人日 |
| E：输入区提示、详情和状态生命周期 | 2–3 人日 |
| 整体验证、真机验收和问题修正（跨包验收） | 1–2 人日 |
| **合计** | **12–18 人日** |

估算包含相关测试与文档，不包含新增厂商接入、1.2 安装数据目录改造、断流续接，以及真实厂商账户准备。

### 施工包 A：分类契约和安全提取

依赖：无。

已定结论：豆包专属映射先由独立厂商接入主题确定真实标识、端点与协议，再补映射；不凭外部参考文档新增注册项。所有已注册厂商有通用兜底；专属映射只承诺已核实条目，单独列覆盖表。

**改动文件：** 共 5 个（非测试 3 个、测试 2 个）；不超过 §5.2 非测试文件规模参考。

- `src/shared/model-failure.ts`
- `src/main/model/providers/model-error-classifier.ts`
- `docs/references/model-errors.md`
- `src/shared/model-failure.test.ts`
- `src/main/model/providers/model-error-classifier.test.ts`

**设计与契约：**

#### 安全失败对象

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

#### 分类器与优先级

新增 `src/main/model/providers/model-error-classifier.ts`，提供纯函数：

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

**实施范围（保留原改动清单）：**

- 新增 `src/shared/model-failure.ts`：安全 DTO、枚举、验证函数。
- 新增 `src/main/model/providers/model-error-classifier.ts`：协议限定的提取和分类。
- 新增上述文件对应的 `.test.ts`。
- 新增 `docs/references/model-errors.md`：Firefly 映射、证据强弱和维护规则。

本步不改变运行行为，可单独合入。

**任务：**

- [ ] A1 精确业务码与 HTTP 状态冲突
  - 先写的测试：`src/main/model/providers/model-error-classifier.test.ts`：精确业务码与 HTTP 状态冲突 → 比较完整分类对象，确认业务码优先；429 欠费不成为 `RATE_LIMIT`。 不误归限流，不泄露原文。
  - 实现：在 model-error-classifier.ts 按精确业务码、厂商 HTTP、通用 HTTP 顺序分类；HTTP 权限或额度不得被通用 SDK 类型覆盖。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

- [ ] A2 同一业务码出现在其他厂商或协议
  - 先写的测试：`src/main/model/providers/model-error-classifier.test.ts`：同一业务码出现在其他厂商或协议 → 不命中专属规则。 不更改厂商、端点或注册配置。
  - 实现：专属规则同时限定实际 providerId 和 protocolMode，未知端点不根据 URL、模型名或自由文本猜厂商。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

- [ ] A3 DeepSeek 402/422、MiMo 421、Anthropic 类型、Kimi 类型、Qwen 业务码
  - 先写的测试：`src/main/model/providers/model-error-classifier.test.ts`：DeepSeek 402/422、MiMo 421、Anthropic 类型、Kimi 类型、Qwen 业务码 → 表驱动逐项比较类别、重试性及安全字段。 未核实映射不启用，不扩大厂商注册范围。
  - 实现：实现首批映射表；docs/references/model-errors.md 逐条记录厂商、协议、精确字段和值、分类、重试性、来源、核对日期及证据强弱。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

- [ ] A4 空响应、HTML、残缺 JSON、未知码、未知状态
  - 先写的测试：`src/main/model/providers/model-error-classifier.test.ts`：空响应、HTML、残缺 JSON、未知码、未知状态 → 不二次抛错，不虚构业务码或状态。 不二次抛错、不输出未知字段。
  - 实现：分类器受限解析非标准响应；解析失败保留已知状态，无法识别则 UNKNOWN。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

- [ ] A5 密钥、提示词、长正文藏在错误字段或 request ID
  - 先写的测试：`src/shared/model-failure.test.ts`：密钥、提示词、长正文藏在错误字段或 request ID → DTO 不包含敏感内容；允许的安全字段仍完整保留。 允许的安全字段完整保留。
  - 实现：在 model-failure.ts 显式构造白名单 DTO，不展开 SDK 异常，不输出原始正文和不可信 request ID。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

- [ ] A6 字段长度、字符集、状态范围
  - 先写的测试：`src/shared/model-failure.test.ts`：字段长度、字符集、状态范围 → 测临界值两侧；未知字段不进入输出。 疑似凭据、超限及未知字段不输出。
  - 实现：实现共享验证函数；合法整数状态、128 字符短码 / request ID、256 字符模型名及受限字符集，疑似凭据或超长字段直接丢弃。
  - 验证：`npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts`

**验收：** A1–A6 全部完成，本包对应 6 条用例全部通过；设计契约、完整安全字段及禁止副作用有断言。执行本包命令与受影响模块检查，PR 记录实际结果和未验证项，CI 通过并按 AGENTS.md 审查；涉及运行行为 / 界面的包在开发版或打包版实际操作。

**回退：** 整体 revert 本包分类契约、分类器、测试与映射文档提交；不改变运行行为，不产生持久化数据。已有下游时先按 E → D → C → B 撤回依赖方。

### 施工包 B：请求边界接线和安全终态

依赖：施工包 A。

已定结论：以精确分类决定重试；鉴权、欠费、额度、参数、内容安全和未知错误不自动重试。外部参考文档一处写所有错误都重试，验收却要求欠费和额度只调用一次，执行本结论。

**改动文件：** 共 14 个（非测试 7 个、测试 7 个）；不超过 §5.2 非测试文件规模参考。

- `src/main/model/errors/agent-runtime-error.ts`
- `src/main/model/providers/prepared-model-call.ts`
- `src/main/model/providers/sdk-stream/runtime.ts`
- `src/main/model/providers/sdk-stream/responses-normalizer.ts`
- `src/main/model/providers/sdk-stream/anthropic-normalizer.ts`
- `src/main/agent/runtime/firefly-agent.ts`
- `src/main/features/chat/agui-bridge.ts`
- `src/main/model/providers/prepared-model-call.test.ts`
- `src/main/model/providers/sdk-stream/runtime.test.ts`
- `src/main/model/providers/sdk-stream/responses-normalizer.test.ts`
- `src/main/model/providers/sdk-stream/anthropic-normalizer.test.ts`
- `src/main/agent/runtime/firefly-agent.test.ts`
- `src/main/features/chat/agui-bridge.test.ts`
- `src/main/features/chat/agui-chat-failure.integration.test.ts`

**设计与契约：**

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

本包先贯通安全失败终态；上述重试 CUSTOM 事件与运行快照在 C 包接入，renderer 在 E 包消费。

**实施范围（保留原改动清单）：**

- 修改 `src/main/model/errors/agent-runtime-error.ts`。
- 修改 `model/providers/prepared-model-call.ts`：受限读取非成功响应并分类，先识别业务码再决定现有重试。
- 修改 `model/providers/sdk-stream/runtime.ts`。
- 修改 `model/providers/sdk-stream/responses-normalizer.ts`、`anthropic-normalizer.ts`：保留受控业务信号，区分业务失败和协议不支持。
- 修改 `firefly-agent.ts`、`src/main/features/chat/agui-bridge.ts`：传递安全详情，保留终态闸门。
- 修改对应测试及 `src/main/features/chat/agui-chat-failure.integration.test.ts`。

本步继续使用当前次数和等待参数，先修复额度类 429 被统一重试的问题。

**任务：**

- [ ] B1 429 额度耗尽
  - 先写的测试：`src/main/model/providers/prepared-model-call.test.ts`：429 额度耗尽 → 网络仅调用一次，终态带安全 `QUOTA`，不等待、不泄露响应正文。 不等待、不重复发送。
  - 实现：修改 agent-runtime-error.ts 和 prepared-model-call.ts，受限读取非成功响应（建议 64 KiB）；先识别业务码再决定现有重试，本包继续当前次数和等待参数。
  - 验证：`npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts`

- [ ] B2 流内 `response.failed` / Anthropic error
  - 先写的测试：`src/main/model/providers/sdk-stream/runtime.test.ts`：流内 `response.failed` / Anthropic error → 保留允许的业务码，不伪造 HTTP 状态，不触发“不支持流式”降级。 不误降级、不虚构状态。
  - 实现：修改 model/providers/sdk-stream/runtime.ts、responses-normalizer.ts、anthropic-normalizer.ts，保留受控业务信号，分开业务失败和协议不支持；两个 normalizer 对应测试同包补齐。
  - 验证：`npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts`

- [ ] B3 包装错误经过真实 Agent 和桥层
  - 先写的测试：`src/main/features/chat/agui-chat-failure.integration.test.ts`：包装错误经过真实 Agent 和桥层 → 比较完整安全事件；终态仅一次。 不重复结算、不产生第二次终态。
  - 实现：修改 firefly-agent.ts 的 safeTerminalError 和 agui-bridge.ts，传递 RUN_ERROR.metadata.fireflyModelFailure 并保留终态闸门；firefly-agent.test.ts、agui-bridge.test.ts 同时断言完整事件。
  - 验证：`npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts`

- [ ] B4 用户取消、工具失败、记忆关闭失败
  - 先写的测试：`src/main/agent/runtime/firefly-agent.test.ts`：用户取消、工具失败、记忆关闭失败 → 不附主模型失败对象；保留原内部错误码与来源。 不附主模型失败对象。
  - 实现：保留 publicRunFailure 的既有内部错误码与来源；非主模型错误不附厂商失败对象。
  - 验证：`npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts`

- [ ] B5 原始异常含凭据
  - 先写的测试：`src/main/features/chat/agui-chat-failure.integration.test.ts`：原始异常含凭据 → 检查 IPC、日志捕获和失败摘要均无敏感原文。 允许安全字段仍完整，无敏感泄露。
  - 实现：在安全终态和日志路径实施白名单清理；捕获 IPC、日志和失败摘要，验证所有输出都没有敏感原文。
  - 验证：`npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts`

**验收：** B1–B5 全部完成，本包对应 5 条用例全部通过；设计契约、完整安全字段及禁止副作用有断言。执行本包命令与受影响模块检查，PR 记录实际结果和未验证项，CI 通过并按 AGENTS.md 审查；涉及运行行为 / 界面的包在开发版或打包版实际操作。

**回退：** 整体 revert 本包请求边界及安全终态接线，恢复既有内部终态和通用摘要；先处理依赖包，新增事件发送方与读取方同步撤回，安全脱敏修复保留。

### 施工包 C：可配置重试和统一等待

依赖：施工包 B。

已定结论：现状额外重试为 2，外部参考文档建议 5；采用默认 2，允许 0–10，降低失败等待和重复计费风险。Retry-After 上限从 20 秒提高为接受不超过 5 分钟且不越过运行预算的建议；超限停止，不能提前重试。1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`；数据目录及生产安装标识归启动与发布主题统一负责，本主题将其作为发布前置条件，不迁移 1.1.x。

**改动文件：** 共 16 个（非测试 11 个、测试 5 个）；不超过 §5.2 非测试文件规模参考。

- `src/main/model/providers/model-request-retry.ts`
- `src/main/model/providers/prepared-model-call.ts`
- `src/shared/timeout-types.ts`
- `src/main/platform/settings/timeout-manager.ts`
- `src/main/agent/memory-runtime/main-memory-runtime.ts`
- `src/main/agent/runtime/firefly-agent.ts`
- `src/main/features/chat/agui-bridge.ts`
- `src/renderer/settings/index.html`
- `src/renderer/settings/timeout/dom.ts`
- `src/renderer/settings/timeout/panel.ts`
- `src/renderer/settings/i18n/zh-CN.json`
- `src/main/model/providers/model-request-retry.test.ts`
- `src/main/model/providers/prepared-model-call.test.ts`
- `src/main/agent/memory-runtime/main-memory-runtime.test.ts`
- `src/main/platform/settings/timeout-manager.test.ts`
- `src/renderer/settings/timeout/panel.test.ts`

**设计与契约：**

优先在 `prepared-model-call.ts` 现有发送循环内改造，新增纯策略文件 `model-request-retry.ts`，不在外层反复调用已消费的 `PreparedModelCall`。

已定策略：

- 配置 `modelRequestMaxRetries`，表示额外尝试次数，默认 **2**，范围 **0–10**；默认值已由负责人确认。
- 允许自动重试：`RATE_LIMIT`、`TIMEOUT`、`NETWORK`、`OVERLOADED`、`SERVER_ERROR`、`UNAVAILABLE`。
- 其他类别默认不自动重试；`QUOTA` 即使带等待建议，也不自动循环等待账户恢复。
- 普通退避以 2 秒起步、指数增长、上限 60 秒，采用 50%–100% jitter。
- 合法 `Retry-After` 优先，不加 jitter；最大接受 5 分钟。若建议超过上限，停止自动重试，不能截短后提前请求。
- 等待和再次发送均受剩余运行预算约束；预算不足时停止，不多发一次请求。
- 所有等待立即响应取消；取消、授权撤销、档案变更、记忆边界拒绝均不重试。
- 保持 SDK `maxRetries: 0`。
- 每次实际发送重新执行 `check` 和 `guardSend`，保留原请求字节、鉴权及端点限制。
- 本期保留现有“成功响应体开始后不重放”的保守边界；即使尚未展示文字，也不自动重连流。至少保证文本、推理或工具调用增量出现后绝不重放。
- 失败尝试不得触发工具执行、追加 assistant 历史或重复记账。不能承诺厂商侧失败尝试不计费。

流式明确不支持时，沿用现有非流式降级。降级不是一次额外重试；流内业务失败不得误触发降级。流式和降级请求共享同一操作预算，降级后直接使用非流式方式，避免反复探测。

历史压缩摘要使用相同分类和有限等待策略，但标记为 `summary`，不冒充最终回复失败。保留现有压缩安全边界；不为接入重试绕过记忆授权发送机制。

#### 运行快照与设置

沿用现有超时设置存储和 IPC：

- `TimeoutSettings` 增加 `modelRequestMaxRetries`。
- `timeout-manager.ts` 在加载、保存边界统一校验：缺失取默认；非有限值取默认；有限值取整并限制到 0–10。
- 每次运行创建不可变配置快照，禁止持有 `getTimeoutSettings()` 返回的可变对象作为运行策略。
- “运行设置”增加数字输入：“模型请求重试次数”。
- 帮助文案：“首次失败后的额外尝试次数，0 表示关闭。仅重试暂时性故障。”
- 不因切换模型档案改变全局值。

不改变现有单次超时、静默监控和整轮超时的含义；分别测试其与等待预算的关系。

**实施范围（保留原改动清单）：**

- 新增 `vendors/model-request-retry.ts` 及测试。
- 修改 `prepared-model-call.ts`，替换两套等待逻辑。
- 修改 `src/shared/timeout-types.ts`、`src/main/platform/settings/timeout-manager.ts`。
- 修改 `src/main/agent/memory-runtime/main-memory-runtime.ts`：注入可信运行快照、预算和安全重试回调，保留发送权限校验。
- 修改 `firefly-agent.ts`、`src/main/features/chat/agui-bridge.ts`：运行快照及 CUSTOM 事件。
- 修改 `src/renderer/settings/index.html`、`timeout/dom.ts`、`timeout/panel.ts`、`i18n/zh-CN.json`。
- 修改对应测试。

**任务：**

- [ ] C1 额外次数为 0/1/10
  - 先写的测试：`src/main/model/providers/model-request-retry.test.ts`：额外次数为 0/1/10 → 实际最多发送 1/2/11 次；预算耗尽不多发。 预算耗尽不多发。
  - 实现：新增 model-request-retry.ts 纯策略并改造 prepared-model-call.ts 既有循环，额外次数默认 2、范围 0–10；等待与发送共享剩余预算，不重新消费 PreparedModelCall。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C2 暂时错误后成功
  - 先写的测试：`src/main/model/providers/prepared-model-call.test.ts`：暂时错误后成功 → 成功只结算一次；失败尝试无历史追加、工具执行或重复记账。 无历史追加、工具调用和重复记账。
  - 实现：在发送循环内处理暂时故障和一次成功结算，main-memory-runtime.ts 注入预算 / 回调；失败尝试不追加历史、不执行工具、不重复记账。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C3 鉴权、权限、欠费、额度、参数、内容过滤、未知错误
  - 先写的测试：`src/main/model/providers/prepared-model-call.test.ts`：鉴权、权限、欠费、额度、参数、内容过滤、未知错误 → 仅一次发送。 不等待、不再次发送。
  - 实现：仅 RATE_LIMIT、TIMEOUT、NETWORK、OVERLOADED、SERVER_ERROR、UNAVAILABLE 自动重试；QUOTA 即使带建议也不等待账户恢复。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C4 秒数、日期、非法值、过去日期及超过上限的 `Retry-After`
  - 先写的测试：`src/main/model/providers/model-request-retry.test.ts`：秒数、日期、非法值、过去日期及超过上限的 `Retry-After` → 断言确定等待结果和是否停止。 不提前重试、不超预算发送。
  - 实现：合法 Retry-After 优先且无 jitter，接受不超过 5 分钟且不越过运行预算的建议；超限停止，不能截短后提前请求。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C5 jitter 与退避上下限
  - 先写的测试：`src/main/model/providers/model-request-retry.test.ts`：jitter 与退避上下限 → 注入确定随机源、使用假定时器，测试临界点。 假定时器结束后恢复，取消后不发送。
  - 实现：普通退避从 2 秒指数增长，上限 60 秒、50%–100% jitter；替换 prepared-model-call.ts 两套等待逻辑，全部等待可取消。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C6 等待中取消、运行结束、授权撤销或档案变更
  - 先写的测试：`src/main/model/providers/prepared-model-call.test.ts`：等待中取消、运行结束、授权撤销或档案变更 → 无后续网络发送；返回稳定取消或边界错误。 无后续网络发送。
  - 实现：prepared-model-call.ts 和 main-memory-runtime.ts 统一检查取消、运行结束、授权撤销和档案变更，返回稳定取消或边界错误，不再发送。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C7 重试前忘记记忆或发送许可失效
  - 先写的测试：`src/main/agent/memory-runtime/main-memory-runtime.test.ts`：重试前忘记记忆或发送许可失效 → 再次经过 guard，拒绝后不发送旧请求。 拒绝后不发送旧请求。
  - 实现：每次实际发送重新执行 check 和 guardSend，保留原请求字节、鉴权和端点限制；不得重建或重复消费准备好的许可；按 read-only、per-action、full 三档验证边界。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C8 运行中修改设置
  - 先写的测试：`src/main/agent/memory-runtime/main-memory-runtime.test.ts`：运行中修改设置 → 当前运行次数不变，新运行使用新快照。 不因切换模型档案改变全局值。
  - 实现：修改 firefly-agent.ts、agui-bridge.ts、main-memory-runtime.ts，注入可信不可变配置快照、预算与安全 firefly.model.retry CUSTOM 回调，不持有可变 getTimeoutSettings() 对象。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

- [ ] C9 设置保存及重启读取
  - 先写的测试：`src/main/platform/settings/timeout-manager.test.ts`：设置保存及重启读取 → 使用临时目录真实文件；保留 0，非法输入按约定归一，清理目录。 不读写 1.1.x，越界 / 错误路径无目录外写入，临时目录清理。
  - 实现：修改 timeout-types.ts、timeout-manager.ts、settings/index.html、timeout/dom.ts、timeout/panel.ts、settings/i18n/zh-CN.json；加载 / 保存边界统一归一，保留 0；panel.test.ts 同包覆盖输入、帮助文案、保存及重启读取，补越界路径和错误路径断言且无目录外写入。
  - 验证：`npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts`

**验收：** C1–C9 全部完成，本包对应 9 条用例全部通过；设计契约、完整安全字段及禁止副作用有断言。执行本包命令与受影响模块检查，PR 记录实际结果和未验证项，CI 通过并按 AGENTS.md 审查；涉及运行行为 / 界面的包在开发版或打包版实际操作。

**回退：** 先将 modelRequestMaxRetries 设为 0 关闭自动重试；代码回退时先处理 D / E，整体 revert 本包策略、设置和事件接线，可选字段不要求历史迁移；不能恢复读取 1.1.x。

### 施工包 D：降级、摘要及三模式衔接

依赖：施工包 C。

已定结论：本期保留响应开始后不重放，即使尚无文字；后续单独设计去重与恢复。摘要最终失败不显示主模型专属错误项，保留明确标注的压缩失败提示与原历史。

**改动文件：** 共 7 个（非测试 3 个、测试 4 个）；不超过 §5.2 非测试文件规模参考。

- `src/main/agent/runtime/chat-loop.ts`
- `src/main/agent/loop/agent-loop-llm.ts`
- `src/main/agent/loop/agent-loop.ts`
- `src/main/agent/runtime/chat-loop.test.ts`
- `src/main/agent/loop/agent-loop-llm.test.ts`
- `src/main/agent/loop/agent-loop.test.ts`
- `src/main/agent/loop/compaction.test.ts`

**设计与契约：**

| 模式 | 请求与界面行为 |
|---|---|
| Chat | 无工具 ChatLoop、有工具 Harness 均接入；等待显示于当前轮活动区；最终主模型失败显示输入区错误项 |
| Work | 每轮主模型操作独立预算；前面成功的工具结果保留；后续模型失败不能重跑已完成工具；摘要等待明确显示“正在重试上下文压缩请求” |
| Code | 沿用 Work 执行链和同一输入区组件；保留工作区、终端、文件及 Git 状态，错误提示不得暗示代码操作已回滚或可安全重复执行 |

不得通过外层重跑整个 Harness 来实现模型重试。

**实施范围（保留原改动清单）：**

- 修改 `src/main/agent/runtime/chat-loop.ts`：共享操作预算，限制图片降级触发条件。
- 修改 `src/main/agent/loop/agent-loop-llm.ts`：流式降级共享预算，摘要使用统一重试策略与超时。
- 修改 `src/main/agent/loop/agent-loop.ts`：向摘要传入运行快照、剩余预算和状态回调。
- 修改上述文件对应测试，增加 Chat / Work / Code 集成场景。

不得通过外层重跑整个 Harness 来实现模型重试。

**任务：**

- [ ] D1 流式明确不支持后非流式成功
  - 先写的测试：`src/main/agent/loop/agent-loop-llm.test.ts`：流式明确不支持后非流式成功 → 降级不消耗额外次数、不重复探测、不重复记账。 不重复探测、不重复记账。
  - 实现：在 chat-loop.ts、agent-loop-llm.ts 共享操作预算，明确不支持流式才降级；降级后直接非流式，避免反复探测。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

- [ ] D2 已收到文本、推理、工具调用片段或已开始成功响应体后断流
  - 先写的测试：`src/main/agent/loop/agent-loop-llm.test.ts`：已收到文本、推理、工具调用片段或已开始成功响应体后断流 → 不重放；不执行残缺工具调用。 不重放、不执行残缺工具调用。
  - 实现：保持成功响应体开始后不重放，即使尚无文字；不执行残缺工具调用，不通过外层重跑 Harness 重试。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

- [ ] D3 Work / Code 已完成工具后下一轮模型失败
  - 先写的测试：`src/main/agent/loop/agent-loop.test.ts`：Work / Code 已完成工具后下一轮模型失败 → 工具调用次数保持一次，结果保留。 不重跑工具、不丢失结果。
  - 实现：Chat 无工具 ChatLoop、有工具 Harness 和 Work / Code 集成场景共用策略；每轮主模型独立预算，已完成工具结果保留，Code 工作区、终端、文件与 Git 状态保留。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

- [ ] D4 摘要暂时失败再成功
  - 先写的测试：`src/main/agent/loop/compaction.test.ts`：摘要暂时失败再成功 → 原历史只在成功摘要后替换。 失败尝试不提前替换历史。
  - 实现：agent-loop-llm.ts 的摘要使用统一分类、重试和超时；agent-loop.ts 传入快照、剩余预算、状态回调，摘要成功后才替换历史。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

- [ ] D5 摘要最终失败或取消
  - 先写的测试：`src/main/agent/loop/compaction.test.ts`：摘要最终失败或取消 → 原历史不被空摘要覆盖，不出现主模型输入区专属错误项。 不显示主模型专属错误项。
  - 实现：摘要操作标记 summary，等待显示“正在重试上下文压缩请求”；失败 / 取消保留原历史和明确压缩失败提示，不显示主模型专属错误项，不绕过记忆授权。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

- [ ] D6 图片请求 400 且分类非 `INVALID_REQUEST`
  - 先写的测试：`src/main/agent/runtime/chat-loop.test.ts`：图片请求 400 且分类非 `INVALID_REQUEST` → 不触发图片文字替代。 不触发图片文字替代。
  - 实现：修改 chat-loop.ts 图片降级条件，400 本身不构成文字替代的充分条件，必须按精确分类判断。
  - 验证：`npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness`

**验收：** D1–D6 全部完成，本包对应 6 条用例全部通过；设计契约、完整安全字段及禁止副作用有断言。执行本包命令与受影响模块检查，PR 记录实际结果和未验证项，CI 通过并按 AGENTS.md 审查；涉及运行行为 / 界面的包在开发版或打包版实际操作。

**回退：** 先处理依赖包 E，再整体 revert 本包降级、摘要及三模式接线；保留原历史与已完成工具结果，不能重跑整个运行恢复。

### 施工包 E：输入区提示和临时状态

依赖：施工包 D。

已定结论：本期不增加“复制诊断信息”；先交付安全详情，后续单独定义复制白名单。

**改动文件：** 共 11 个（非测试 7 个、测试 4 个）；不超过 §5.2 非测试文件规模参考。

- `src/renderer/react/features/chat/pages/chat-page-bridge.ts`
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`
- `src/renderer/react/features/chat/pages/ChatPage.tsx`
- `src/renderer/react/features/chat/components/ChatComposer.tsx`
- `src/renderer/react/features/chat/components/ChatComposer.css`
- `src/renderer/react/features/chat/components/ModelFailureNotice.tsx`
- `src/renderer/react/i18n/zh-CN.json`
- `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`
- `src/renderer/react/features/chat/pages/ChatPage.test.ts`
- `src/renderer/react/features/chat/components/ModelFailureNotice.test.ts`
- `src/renderer/react/features/chat/components/ChatComposer.test.ts`

**设计与契约：**

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

**实施范围（保留原改动清单）：**

- 修改 `src/renderer/react/features/chat/pages/chat-page-bridge.ts`：扩展安全事件类型。
- 修改 `pages/run/AgentRunController.ts`：校验事件、更新临时状态和轮次摘要。
- 修改 `pages/ChatPage.tsx`：按会话持有最近失败及重试状态。
- 修改 `components/ChatComposer.tsx`、`ChatComposer.css`。
- 新增 `components/ModelFailureNotice.tsx` 及测试：错误项与详情弹窗。
- 修改 `src/renderer/react/i18n/zh-CN.json`；按现有语言资源结构补充对应键，禁止界面直接展示枚举名。
- 修改 `AgentRunController.test.ts`、`ChatPage.test.ts`、`ChatComposer.test.ts`。

**任务：**

- [ ] E1 当前运行最终主模型失败
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：当前运行最终主模型失败 → 一条错误项、正确中文建议、详情字段与对应轮次摘要。 不重复展示、不泄露原文。
  - 实现：扩展 chat-page-bridge.ts 安全事件类型，AgentRunController.ts 校验并更新轮次摘要，ChatPage.tsx 按会话持有失败；ChatComposer.tsx / .css 在 PendingQueueDock 与 ff-composer-shell 之间加入 ModelFailureNotice.tsx；补中文资源及 ChatComposer.test.ts。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

- [ ] E2 重复终态、旧运行迟到事件
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：重复终态、旧运行迟到事件 → 不重复记录，不覆盖新运行。 不重复记录、不覆盖新运行。
  - 实现：按当前会话、当前运行身份和终态闸门拒绝重复及迟到事件，不覆盖新运行。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

- [ ] E3 切换会话、新轮启动、取消、恢复
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.test.ts`：切换会话、新轮启动、取消、恢复 → 状态归属和清除符合设计。 不串用其他会话状态。
  - 实现：ChatPage.tsx 与 AgentRunController.ts 在真正新轮启动、取消和恢复时按设计清理；切换会话只显示目标状态。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

- [ ] E4 无安全详情或畸形 metadata
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：无安全详情或畸形 metadata → 通用错误仍正常显示，无异常崩溃。 不崩溃、不展示畸形详情。
  - 实现：renderer 再次验证可选安全对象，畸形对象回退现有通用错误提示，不直接展示枚举名。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

- [ ] E5 重试等待到成功
  - 先写的测试：`src/renderer/react/features/chat/pages/ChatPage.test.ts`：重试等待到成功 → 临时状态清除，持久化消息不含重试状态。 持久化消息不含重试状态。
  - 实现：重试成功、最终失败、取消、恢复会话及首次有效输出清除重试状态；不写入消息正文、历史、检查点或活动持久化记录。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

- [ ] E6 键盘打开和关闭弹窗
  - 先写的测试：`src/renderer/react/features/chat/components/ModelFailureNotice.test.ts`：键盘打开和关闭弹窗 → 焦点正确恢复；缺失字段隐藏；无 raw error 文本。 无 raw error，缺失字段隐藏。
  - 实现：ModelFailureNotice.tsx 使用现有 Ant Design Modal、role="status"、aria-live="polite"，支持 Escape、焦点进入与关闭后返回；文档入口固定白名单，本期不增加“复制诊断信息”。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts src/renderer/react/features/chat/components/ModelFailureNotice.test.ts src/renderer/react/features/chat/components/ChatComposer.test.ts`

**验收：** E1–E6 全部完成，本包对应 6 条用例全部通过；设计契约、完整安全字段及禁止副作用有断言。执行本包命令与受影响模块检查，PR 记录实际结果和未验证项，CI 通过并按 AGENTS.md 审查；涉及运行行为 / 界面的包在开发版或打包版实际操作。

**回退：** 整体 revert 本包输入区 UI 与读取方，界面回到现有通用失败摘要；移除读取方前同步撤回新增事件发送方，无历史数据迁移，脱敏修复保留。

## 验收清单（全量）

- [ ] 施工包 A 的全部任务、6 条原测试用例、设计细节及包验收完成并合并。
- [ ] 施工包 B 的全部任务、5 条原测试用例、设计细节及包验收完成并合并。
- [ ] 施工包 C 的全部任务、9 条原测试用例、设计细节及包验收完成并合并。
- [ ] 施工包 D 的全部任务、6 条原测试用例、设计细节及包验收完成并合并。
- [ ] 施工包 E 的全部任务、6 条原测试用例、设计细节及包验收完成并合并。
- [ ] 32 条原测试用例逐条落到 A1–E6，精确错误分类、安全 DTO、逐次 guard、重试预算、摘要及 UI 生命周期均通过，无敏感泄露、重复工具、历史写入或结算。
- [ ] 三档权限逐次发送校验通过；取消、授权撤销、档案变更、忘记记忆或发送许可失效后不发送旧请求。
- [ ] 分别验证既有单次超时、静默监控、整轮超时与等待预算关系，不改变原超时含义。
- [ ] 最近测试、模块测试、存储边界、主进程 / preload 构建、renderer 类型检查与构建、全量测试、diff 空白检查通过，进度文档记录日期、命令、通过数和未验证项。
- [ ] 全量 `npm test` 所需 `FIREFLY_TEST_BASH` 指向可用 Git Bash；环境不足的断言显式跳过并记录原因。
- [ ] 真机步骤 1–6 有操作、结果和证据；厂商账户尚未提供时明确记录补验条件及未验证范围，不以替身冒充厂商实测。
- [ ] 启动与发布主题完成 1.2 数据与安装身份隔离，正式数据目录为 `%APPDATA%\Firefly-1.2.0`，不读取或迁移 1.1.x。
- [ ] 每包一个 PR、无无关修改、CI 通过；同一 PR 最多三轮审查，仍有分歧按流程重新讨论方案。
- [ ] 所有施工包合并且验收全勾后，在进度文档记录全量测试、类型检查、构建及真机结果，将两份文档状态改为“已完成”。

### 验证命令与真机步骤

依据 `package.json`，`npm test` 调用 `scripts/testing/run-tests.mjs`，支持传入测试路径并保留测试归档 reporter。实施阶段按施工包执行，不能用历史报告代替本次结果。

```powershell
# 施工包 A
npm test -- src/shared/model-failure.test.ts src/main/model/providers/model-error-classifier.test.ts

# 施工包 B
npm test -- src/main/model/providers/prepared-model-call.test.ts src/main/model/providers/sdk-stream src/main/agent/runtime/firefly-agent.test.ts src/main/features/chat/agui-bridge.test.ts src/main/features/chat/agui-chat-failure.integration.test.ts

# 施工包 C
npm test -- src/main/model/providers/model-request-retry.test.ts src/main/model/providers/prepared-model-call.test.ts src/main/agent/memory-runtime/main-memory-runtime.test.ts src/main/platform/settings/timeout-manager.test.ts src/renderer/settings/timeout/panel.test.ts

# 施工包 D
npm test -- src/main/agent/runtime/chat-loop.test.ts src/main/agent/runtime/harness

# 施工包 E
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

其中新增测试路径在对应施工包建立后执行。使用项目要求的 Node.js 24 和 npm；不新增检查工具、不降低阈值、不修改 CI 策略。

真机验收：

1. 使用已确认的 1.2 独立数据目录 `%APPDATA%\Firefly-1.2.0`；开发或 smoke 档案通过现有 `FIREFLY_RUNTIME_PROFILE`、`FIREFLY_ISOLATION_ROOT` 配置。启动前确认目录与 1.1.x 分离。
2. 在实施环境运行 `npm run dev`，使用可控本地模型响应服务，依次产生 401、402、429 限流、429 额度、503、非 JSON 错误和流中断。
3. Chat 分别验证无工具和有工具路径；Work / Code 在工具完成后令下一次模型请求失败，确认无重复操作。
4. 验证等待时取消、切换会话、重新发送、设置保存及重启。
5. 检查中文错误项、弹窗键盘操作、窄窗口和主题；确认日志、历史及测试响应中的敏感哨兵值未泄露。
6. 真实厂商联通性只在负责人提供测试账户后补验，不用真实欠费、额度耗尽或高频请求制造测试故障。

计划阶段，以上测试、构建和 UI 验收均未执行，文档检查不计为功能通过。

### 真机结果勾选

- [ ] 1：独立目录与 1.1.x 分离。
- [ ] 2：本地可控故障覆盖 401、402、两类 429、503、非 JSON 和流中断。
- [ ] 3：Chat 双路径及 Work / Code 工具完成后失败无重复操作。
- [ ] 4：等待取消、切换会话、重新发送、设置保存及重启。
- [ ] 5：中文、键盘、窄窗口、主题及敏感哨兵无泄露。
- [ ] 6：提供账户后补验真实厂商联通性并记录范围。

## 回滚方案

### 风险与防护

- **厂商与协议误匹配**：兼容协议不代表同一厂商语义。规则同时限定实际厂商和协议；未知信号回退通用分类。
- **重试绕过授权**：不得重建、重复消费准备好的请求许可；保留每次发送前的 guard。此项失败阻止合入。
- **重复输出或外部副作用**：本期不做断流续接，响应开始后停止自动重放；禁止通过重跑整个运行来恢复模型请求。
- **错误详情泄露**：主进程与 renderer 双重白名单校验，原始正文不进入事件和历史；无法确认安全的字段直接省略。
- **等待过长**：等待受运行剩余预算约束，取消立即生效；超长服务端建议直接停止自动重试。
- **数据目录尚未隔离**：当前 production 路径未体现版本隔离。发布和真机持久化验收必须以前置隔离完成为条件，不读取或迁移 1.1.x 数据。
- **参考资料证据不足**：观察性或未复核规则不能伪装为已确认厂商协议，先保留通用分类。
- **回退方式**：运行设置设为 0 可关闭自动重试；界面可回退到现有通用失败摘要。代码按 A–E 五个施工包分组撤回，移除读取方前同步撤回新增事件发送方。新增安全字段保持可选，不需要历史数据迁移。安全脱敏修复不随体验回退一并撤销。

### 按包撤回顺序

依赖完整时按 E → D → C → B → A 整体 revert 每包合并提交；具体回退见各包。先关闭自动重试，再同步处理读取方和新增事件发送方；安全脱敏修复保留。没有历史迁移，不通过恢复旧数据目录回滚。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

无。
