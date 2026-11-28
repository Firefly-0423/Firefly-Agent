状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 运行终态、取消与工具事实

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
把“模型决定结束”“执行收敛”“权威记录提交”和“界面保存”分开，保证取消或结果未知时不虚构成功。原运行边界子目录的两篇说明合并于此，不保留第二套施工计划。

## 当前实现
| 责任 | 文件与关键类型 |
|---|---|
| 会话运行所有权 | `src/main/features/chat/agui-bridge.ts` 的 `runsByConversation` 及按 runId 校验的释放逻辑；忙时返回 `SESSION_RUN_ACTIVE`，接管未收敛返回 `SESSION_RUN_TAKEOVER_STUCK`。 |
| 单终态 | `src/main/conversation/transcript/run-settlement.ts` 的 `RunSettlementGate`；共享结果见 `src/shared/run-terminal.ts`。 |
| 取消与收尾 | `src/main/agent/loop/agent-loop.ts` 的 `runAgentLoop`、`drainRunExecution`；`src/main/agent/runtime/adapter/tool-runtime.ts` 合成 signal 并传给工具与伙伴。 |
| 工具归一化 | `src/main/tooling/registry/tool-executor.ts` 的 `executeToolDefinition`；`src/main/agent/loop/types.ts` 的 `ToolObservation` 区分 success、failure、unknown、not_executed。 |
| 成功重放 | `src/main/agent/loop/execution-ledger.ts` 的 `ExecutionLedger`；`src/main/agent/loop/tool-dispatcher.ts` 构建逻辑调用身份。 |
| 未决保护 | `src/main/agent/loop/uncertain-effect-guard.ts` 的 `findBlockingUncertainEffect`；确认入口位于 `src/main/agent/loop/builtin-tools.ts`。 |

## 行为与失败边界
取消 IPC 定位真实运行并清理其等待交互；发出 signal 不等于远端操作已回滚。主循环等待受管理执行落定，终态仍可带 `externalEffectsMayContinue`。解除订阅、运行结束、`AGUI_RUN_PERSISTED` 不能互相替代。

相同逻辑身份和相同事实可重放已缓存终态成功；身份相同而参数等事实冲突，抛 `E_LOGICAL_INVOCATION_CONFLICT`；新 ID 的相同参数代表新意图。账本是内存 Map，完成后才缓存，不能承诺跨重启或并发唯一执行者。

未知副作用按类型敏感指纹阻断相关重复操作；参数不可用时按工具名保守处理。当前确认会移除未决项，不构成持久化一次授权的原子消费证明。Guard 约束操作，不禁止模型诚实解释未知结果并结束。

`src/main/agent/tools/fs-tools.ts` 的写入结果允许零字节文件；写入后取证失败返回未知效果，不以“文件非空”判断成功。相关断言在 `src/main/agent/tools/fs-tools.test.ts`。

## 未完成与验收归属
[会话可靠性计划](../superpowers/plans/conversation-reliability.md)负责 durable 回执、一次授权、接纳和重启对账；[命令实时输出计划](../superpowers/plans/command-live-output.md)负责取消后的有界输出收尾。本文不重排施工。

现有测试入口：`src/main/agent/loop/execution-ledger.test.ts`、`src/main/agent/loop/uncertain-effect-guard.test.ts`、`src/main/agent/loop/agent-loop-cancel.test.ts`、`src/main/features/chat/agui-bridge.test.ts`。真实进程树、远端副作用及崩溃窗口未在本次验证。
