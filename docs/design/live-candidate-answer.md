状态：设计提案（现状整理）
实现状态：已实现

# Firefly 候选正文与正式回答

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
在模型轮次结束前展示正文预览，同时避免把过程或中断片段保存成成功回答。

## 当前实现
| 已实现行为 | 代码依据 |
|---|---|
| 模型增量到候选事件 | `src/main/agent/loop/agent-loop-llm.ts` 回传文本增量；`src/main/agent/loop/agent-loop.ts` 绑定轮次并发出 candidate_text_delta。 |
| 跨进程投影 | `src/main/agent/runtime/adapter/event-mapper.ts` 的 `sendAgentLoopEventAsAgui` 映射 `firefly.candidate_text`；正式正文仍使用 `TEXT_MESSAGE_*`。 |
| 预览与渐显 | `src/renderer/react/features/chat/pages/run/AgentRunController.ts` 的 `appendCandidateDelta` 使用 `SmoothTextRevealQueue`，首段先发布，其余按绘制帧排出，减少动态效果时直接排空。 |
| 正式提交条件 | `src/renderer/react/features/chat/components/run-presentation.ts` 的 `isFormalAnswerCommitted` 要求 success、正文闭合且非空；控制器以权威全文替换预览。 |
| 中断与保存 | 同一控制器的 `moveCandidateToInterruptedProcess` 保留中断过程；`buildCheckpoint` 不保存 transientText，非终态 content 为空。 |

## 行为与失败边界
RunEventGate 接纳运行事件后，控制器还核对 roundId。工具过程正文归类为 processMessages；discard 或下一轮关闭候选会保留过程文字，不能从事件名推断丢掉全部文字。取消、超时、错误或缺正式正文时不提交成功回答，候选转为 interrupted 过程。

候选不等于工具结果或最终权威正文；两份全文不同也只能形成一份正式回答。尚未归类的候选只在内存，刷新或崩溃可能丢失。普通无工具 Chat 有独立执行路径，不能仅凭主循环候选证据承诺所有模式事件完全相同。

## 未完成与维护
跨刷新恢复半截预览、修改渐显延迟预算未获决定；本次没有首字延迟、视觉跳动或语音效果证据。持久化终态和缺合法流终态的行为由[会话可靠性计划](../superpowers/plans/conversation-reliability.md)承接，时间线见[统一运行视图](runtime-unified-view.md)。

现有测试入口：`src/main/agent/loop/agent-loop.test.ts`、`src/main/agent/runtime/adapter/event-mapper.test.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`。本次未执行；后续比较完整正文及有序事件，拒绝旧运行事件造成写入。
