状态：设计提案（现状整理）
实现状态：已实现

# Firefly 统一运行时间线

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
把推理片段、过程正文、工具和伙伴摘要按同一次运行展示，区分临时候选与正式回答。

## 当前实现
`src/shared/chat-types.ts` 定义展示记录；`src/renderer/react/features/chat/pages/run/AgentRunController.ts` 投影 reasoningBlocks、processMessages、toolExecutions、taskDelegations 与运行快照。transientText 仅用于候选，正文生命周期见[候选正文](live-candidate-answer.md)。

`src/renderer/react/features/chat/components/agent-rounds.ts` 的 `buildFlatRunTimeline` 按 seq 合并记录，缺序号时回退旧工具位置规则，伙伴摘要按委派关系定位；`foldRunTimeline` 折叠连续适合分组的成功步骤。`src/renderer/react/features/chat/components/ChatMessageList.tsx` 装配活动详情，`src/renderer/react/features/chat/components/run-activity.ts` 管理展开偏好。

## 行为与失败边界
seq 是渲染端接受并投影的展示顺序，不是跨进程持久全局序号，也不是工具实际完成时刻排序。运行中可以分组，不能描述为始终完全平铺。

有正式正文的成功只保留一份回答；工具轮文字进入过程，取消、超时、错误和缺权威正文保留中断过程，不转正。完成折叠受 keepExpanded 与用户选择影响，不改变工具事实。ask_user 的已发生问答可在运行卡成对展示，输入仍由交互卡负责；展开不作答、不批准，结果预览也不保证问答完整未截断。

## 未完成与维护
当前没有独立持久化的“最终回答分界线”字段；固定所有终态 DOM 身份、禁用运行中分组或更改展开偏好均未决定。权威终态和展示降级见[会话可靠性计划](../superpowers/plans/conversation-reliability.md)。

现有测试：`src/renderer/react/features/chat/components/agent-rounds.test.ts`、`src/renderer/react/features/chat/components/ChatMessageList.test.ts`、`src/renderer/react/features/chat/components/run-activity.test.ts`。本次未执行；滚动、焦点、视觉稳定性和性能需界面验收。
