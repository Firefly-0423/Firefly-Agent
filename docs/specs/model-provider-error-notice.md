# 模型故障 UI 通知与脱敏展示规范（现状实装基线）

状态：已实现规范（核验日期 2026-11-16）

> **范围说明**：本文档仅规范当前仓库已实现且有测试守卫的故障上报与渲染进程通知行为。`docs/superpowers/plans/model-error-classification.md` 中规划的 `RUN_ERROR.metadata` 扩展字段与独立故障提示组件当前处于 `未开工`，不在本规范范围内。

---

## 1. 主进程事件载荷脱敏规范

1. **单一终态与去隐私载体（`src/main/features/chat/agui-bridge.ts`）**
   - 每次运行仅允许发射一次终态（由 `RunSettlementGate` 互斥保证）。
   - 失败退出时统一发出 `{ type: "RUN_ERROR", message: safe.code, code: safe.code, errorSource: safe.source, threadId, runId }`。
   - `RUN_ERROR.message` 与 `RUN_ERROR.code` 必须同为 `publicRunFailure` 允许的白名单枚举码，禁止包含厂商 HTTP 响应正文、HTTP 状态拼接串、异常消息原文或环境变量/密钥片段。
   - 用户主动取消（`user_cancelled`）不得发出 `RUN_ERROR`，必须发出 `RUN_FINISHED { result: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true } }`。
   - **守卫测试**：`src/main/features/chat/agui-bridge.test.ts`、`src/main/features/chat/agui-chat-failure.integration.test.ts`（显式断言 `JSON.stringify(sent)` 不匹配敏感或原始错误文本）。

---

## 2. 渲染进程 `AgentRunController` 错误通知规则

模块位置：`src/renderer/react/features/chat/pages/run/AgentRunController.ts`；文案定义：`src/renderer/react/i18n/zh-CN.json`、`en.json`。

### 2.1 运行中失败（`RUN_ERROR` 或异步启动拒绝）

1. 收到 `RUN_ERROR` 后：
   - 立即中止任务计划（`failPlan("failed")`）、补齐 Work 读取报告（`ensureWorkReadReport()`）、停止流式与候选文本 reveal 队列（`cancelPublicReveal()`、`abortCandidateReveal()`）、关闭活动统计（`completeRunActivity(true)`）、更新状态 `runStage = { kind: "failed" }`，并经 `publicRunFailure({ code: event.code, message: event.message })` 结算。
2. 异常处理分支优先检查 `parseSessionRunActiveError(explanation)`：
   - 若命中会话冲突，展示 `t("chatPage.sessionRunActiveNotice")`，并注册 `requestTakeover` 动作供用户携带 `takeoverFromRunId` 接管重发。
3. 非冲突失败时，重新调用 `publicRunFailure(failure)` 并按以下严格优先顺序计算通知文案 `notice`：
   - `code === "E_MODEL_CONNECTION_LOST"` → `t("chatPage.errorNetworkInterrupted", { code })`
   - `code === "E_MODEL_REQUEST_TIMEOUT"` → `t("chatPage.errorModelTimedOut", { code })`
   - 否则按 `source` 分发：
     - `"model"` → `t("chatPage.errorModelRequestFailedWith", { message: code })`
     - `"context"` → `t("chatPage.errorContextFailedWith", { message: code })`
     - `"tool"` → `t("chatPage.errorToolFailedWith", { message: code })`
     - `"runtime"` → `t("chatPage.errorRuntimeFailedWith", { message: code })`
4. 消息状态定格：
   - 调用 `moveCandidateToInterruptedProcess()`，保留半截候选内容为过程记录（待分类候选最多保留一次）。
   - 将 `notice` 作为过程消息条目追加到 `progressEntries`。
   - 调用 `patchFailedProcess()`：**强制清空正式回答 `content: ""`**、置 `responseStarted: false`、`loading: false`、`streaming: false`、`runStage: { kind: "failed" }`，清空 `savedAnswer = ""`，防止失败或半截响应伪装为正式回复。
   - 调用 `settleTerminalSave()` 写入终态快照并释放忙碌状态。

### 2.2 前置失败、冲突接管与终态落盘告警

1. **AG-UI 服务或聊天存储未就绪**：未进入活跃态前直接写入 `t("chatPage.errorModelServiceNotReady")` 到助手消息并暂停队列（`queuePaused: true`）。
2. **`transport.run` 启动返回 `success: false`**：优先抛出 `acknowledgement.error`，缺省时使用 `t("chatPage.errorModelRequestStartFailed")`。
3. **终态快照写盘失败**：`persistTerminal()` 最多尝试 `TERMINAL_SAVE_ATTEMPTS = 3` 次（失败间隔 `TERMINAL_SAVE_RETRY_MS = [100, 300]` ms）；3 次均失败时向 `progressEntries` 追加 `t("chatPage.terminalSaveFailed")`，且**严禁**调用 `reportRunPersisted()`。

### 2.3 守卫测试与 `未覆盖` 清单

- **已有守卫测试**（`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`）：
  - `L77`: 服务未就绪写入错误且不进入忙碌态；
  - `L224` / `L229`: 运行时故障保留一次半截预览与公开失败提示；
  - `L246`: 错误持久化终态快照、汇报故障并释放忙碌态；
  - `L254`: 上下文失败（`MEMORY_CONTEXT_SEND_UNKNOWN` 等）暴露对应类别与公开错误码并拦截模型/敏感原文；
  - `L281`: 会话冲突呈现单次接管操作并沿用旧 run 锚点重试；
  - `L625` / `L658`: 终态落盘重试与写盘失败同时显示错误提示与 `terminalSaveFailed` 且不发回执。
- **明确 `未覆盖` 子项**：
  - `E_MODEL_CONNECTION_LOST`（`chatPage.errorNetworkInterrupted`）、`E_MODEL_REQUEST_TIMEOUT`（`chatPage.errorModelTimedOut`）与 `source === "tool"`（`chatPage.errorToolFailedWith`）在 `AgentRunController.ts` 内触发完整文案渲染的专项单测断言：**未覆盖**；
  - `agui-bridge.ts` 将 `RUN_FINISHED { status: "runtime_error" }` 转译为 `RUN_ERROR` 后再由 `AgentRunController` 消费的跨进程联合回归测试：**未覆盖**；
  - `zh-CN.json` 与 `en.json` 中 `chatPage.error*` 键对齐自动化校验：**未覆盖**。

---

## 3. 设置页与图像路由错误提示规范

1. **设置页拉取模型列表（`src/renderer/settings/i18n/zh-CN.json`、`src/main/model/config/fetch-vendor-models.ts`）**
   - 失败响应键 `settings.panel.api.field.model.fetch.{unauthorized,timeout,notFound,network,http,empty,needKey}` 全部解析为有效字符串，由 `src/renderer/settings/api/fetch-models-i18n.test.ts` 守卫。
2. **图片能力拒识提示（`src/main/model/vision/image-router.ts`）**
   - 不支持直发图片或 `anthropic` 协议禁止视觉转述时，返回 `IMAGE_UNSUPPORTED_REASON` 或协议引导提示，由 `src/main/model/vision/image-router.test.ts` 守卫。
