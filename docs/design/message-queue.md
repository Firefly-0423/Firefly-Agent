状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 待发队列、认领与安全插话

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
当前运行未结束时保存下一条输入，区分等待新运行与插入当前任务。原执行状态总览的队列内容收口于此，候选正文和文件审查分别链接专篇。

## 当前实现
| 已实现行为 | 代码依据 |
|---|---|
| 斜杠菜单未接管时，忙时普通 Enter 入队；Shift+Enter、输入法组合确认不走同一分支，停止独立 | `src/renderer/react/features/chat/components/ChatComposer.tsx` 的 `handleSenderKeyDown` 与 Sender 接线。 |
| 入队确认后按草稿及附件快照清理，失败保留输入 | `src/renderer/react/features/chat/pages/ChatPage.tsx` 的排队入口与 `src/renderer/react/features/chat/pages/pending-queue-flow.ts` 的 `enqueue`。 |
| Main 保存、编辑、删除和认领队列 | `src/main/features/sessions/chats-ipc.ts` 注册 `CHATS_PENDING_*`；`src/main/features/sessions/chats-store.ts` 的 `enqueuePendingMessage`、`claimPendingMessage`、`completePendingDispatch`。 |
| 页面消费与正常结束协调 | `src/renderer/react/features/chat/pages/pending-queue-flow.ts` 的 `consumeCurrent`、`startClaimedRun`、`handleRunFinished`；`src/renderer/react/features/chat/pages/use-pending-queue.ts` 接线。 |
| 插入下一步与撤回插入 | `src/renderer/react/features/chat/components/PendingQueueDock.tsx`；运行侧 `src/main/agent/runtime/pending-adjustment.ts` 消费安全点插话。 |

## 行为与失败边界
流程为入队 → 持久条目 → 认领并保存用户消息与 pendingDispatch → 启动运行 → 接纳后完成派发簿记。页面 processing 防重复消费，不能替代 Main 的会话占用。

`claimPendingMessage` 对已有认领返回 already-dispatching；编辑已认领项返回 already-claimed，删除待发项不撤销已经转入历史的用户消息。入队失败不应清草稿，停止不代表删除剩余队列；审批、提问期间由 `src/renderer/react/features/chat/components/ComposerSlot.tsx` 优先展示交互面板，不能承诺输入框同时可编辑。

`resumePendingDispatch` 对部分残留认领仍调用 startClaimedRun。认领、轨迹和模型接纳不是同一事务，稳定条目 ID 不证明重启零续派或请求恰好执行一次。

## 未完成与计划
稳定请求回执、原子接纳、重启只对账而不续派，归[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)及[进度](../superpowers/plans/2026-11-12-conversation-reliability-progress.md)。三模式输入与停止回归归[提醒与界面计划](../superpowers/plans/2026-11-12-reminders-and-ui.md)，不重新建设队列。

现有测试入口：`src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`、`src/renderer/react/features/chat/pages/pending-queue-flow.test.ts`、`src/main/features/sessions/chats-pending-queue.test.ts`。本次未执行；真实输入法、刷新和崩溃窗口未验收。候选显示见[候选正文](live-candidate-answer.md)，文件执行证据见[文件与差异](workspace-file-and-diff-panels.md)。
