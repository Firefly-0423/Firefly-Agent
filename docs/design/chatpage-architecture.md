状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 聊天页架构与回归边界

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
让页面组合、单次运行投影、消息和输入队列各有所有者，避免会话切换与迟到事件串台。原回归清单并入本文；下列矩阵均为待执行要求。

## 当前实现
| 责任 | 模块与入口 |
|---|---|
| 组合根 | `src/renderer/react/features/chat/pages/ChatPage.tsx` 持有会话选择、模式、草稿、busy、计划及交互状态，协调运行结束后的队列。 |
| 启动与桥 | `src/renderer/react/features/chat/pages/start-agent-run.ts` 创建控制器，`src/renderer/react/features/chat/pages/chat-page-bridge.ts` 定义桥契约。 |
| 单次运行 | `src/renderer/react/features/chat/pages/run/AgentRunController.ts` 的 `AgentRunController`、`AgentRunHost` 处理事件、候选、检查点和终态；事件闸门在 `src/renderer/react/features/chat/pages/run-event-gate.ts`。 |
| 消息 | `src/renderer/react/features/chat/hooks/useSessionMessages.ts`、`src/renderer/react/features/chat/pages/use-conversation-messages.ts` 汇聚消息投影。 |
| 作用域与输入 | `src/renderer/react/features/chat/pages/use-session-scope.ts`、`src/renderer/react/features/chat/pages/use-composer-scope.ts`、`src/renderer/react/features/chat/hooks/useComposerAttachments.ts` 管理最新引用、草稿和附件生命周期。 |
| 队列 | `src/renderer/react/features/chat/pages/use-pending-queue.ts` 接入独立 flow；详细行为见[待发队列](message-queue.md)。 |

## 行为与失败边界
控制器处理 ACK 前事件及取消意图，得到真实 runId 后取消该运行；旧运行不能清除新运行注册项。选择会话使用代次保护，不能让慢响应覆盖后来选择。检查点串行保存，普通更新为 350ms debounce，终态立即保存；这不是最大等待或跨进程事务保证。

单次运行投影不负责工具授权，Main 仍持有执行和权威轨迹。页面退订不证明 Main 已停止。控制器仍依赖 window、计时器和 i18n，不能描述为完全平台无关；页面卸载期间的运行、帧和等待清理仍需复现验收。当前三模式由 `src/renderer/react/features/chat/pages/chat-page-normalizers.ts` 定义。

## 合并后的回归矩阵
| 输入条件 | 验收要求（本次均未执行） |
|---|---|
| 三模式发送、工具轮与最终回答 | 正式正文只提交一次，工具事实与正文分离。 |
| ACK 前后取消、超时、错误、旧事件迟到 | 正确运行收敛，不写成功正文、不污染其他会话。 |
| 快切会话、编辑末轮、重新生成和接管 | 活动修订与消息归属正确，未确认接管不破坏旧运行。 |
| 忙时 Enter、输入法、入队失败和停止 | 入队不发送/停止，失败保留输入，顺序和附件归属正确。 |
| 审批、选择、抽查、计划的重复或迟到结算 | 仅目标交互结算；拒绝无受保护执行。 |
| 图片、附件、桌面听写 | 授权和释放正确，听写只填草稿，迟到结果不填错会话。 |
| 图表、知识进度、压缩、上下文与性能 | 安全降级和作用域正确；无进度不补建，性能先测量。 |

## 未完成与统一计划
接纳、重启只对账、终态提交见[会话可靠性](../superpowers/plans/conversation-reliability.md)；输出见[命令实时输出](../superpowers/plans/command-live-output.md)；错误反馈见[模型错误分类](../superpowers/plans/model-error-classification.md)；提醒、图片和性能见[提醒与界面](../superpowers/plans/reminders-and-ui.md)。这些目标不能提前勾为通过。

现有最近测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`、`src/renderer/react/features/chat/pages/run-event-gate.test.ts`、`src/renderer/react/features/chat/components/ChatComposer.sender-integration.test.ts`、`src/renderer/react/features/chat/components/desktop-asr-controller.test.ts`。本次未执行；页面进一步分域和卸载接口是否增加仍待实际问题支持。
