状态：设计提案（现状整理）
实现状态：设计目标

# Firefly 同运行计划审批提案

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
让模型提交计划后在同一次 run 等待批准、修改或否决，避免界面代发消息再创建运行。目标流程尚未实现，不将已有计划模式误写成同运行审批。

## 当前实现与入口
`src/main/agent/loop/plan-tools.ts` 的 `executeWritePlan` 写草稿；`src/main/agent/tools/plan-mode.ts` 保存内存计划状态。`src/main/features/chat/agui-bridge.ts` 在现有计划流程发布 review、approved、supplement 事件；`src/renderer/react/features/chat/pages/ChatPage.tsx` 仍消费批准及补充事件并启动后续消息流程。

`src/main/agent/runtime/adapter/plan-lifecycle.ts` 在运行准备时读取计划状态，结束时根据该快照清理。`src/main/agent/loop/tool-round.ts` 已有交互排他和用户等待计时，`src/main/platform/interaction/user-choice.ts` 提供询问卡。当前代码中未找到 submit_plan 控制工具、plan_approval 专用卡或专用审批超时配置。

## 拟议行为与失败处理
以下为设计目标，未实现且未批准：
- 写草稿与交卷分离。提交时由 Main 读取并冻结正文、修订和摘要，绑定会话、run、调用及审批身份；状态不符或读取/保存失败不发审批、不进入执行。
- 排他工具轮等待决定；同轮其余未派发调用逐项 not_executed。批准通过 canonical 工具结果回到同 run，仍走工具权限和未决效果守卫。
- 修改意见非空才接收，回到讨论并重交；否决结束本次计划执行路径，不能因回到 NORMAL 就继续派发被否决操作。
- 停止、撤权、删会话、超时或界面不可用均不默认批准；旧卡、重复、跨会话和迟到答复不得改变新状态。
- 审批等待不计活动执行预算，但仍有独立上限及 signal 清理。默认等待时长与修改轮数尚未决定，不沿用普通询问卡超时冒充支持。
- 工具清单在运行创建时生成，需允许运行中进入讨论后合法交卷；禁用交互的入口不得因此获得等待工具。

## 生命周期与未决定项
同 run 批准会改变启动时计划快照，因此结束清理应绑定实际执行修订和 run 所有权，不能无条件清掉后来运行的新计划。当前完整准备/收尾只显式覆盖 Chat / Code，Work 是否补齐待定；伙伴不得自行批准父计划。界面代发与新审批入口不能同时启用。

状态持久化与重启旧卡失效见[计划权限与恢复](2026-11-12-plan-mode-permission-and-state.md)。运行接纳和安全恢复沿用[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)，提醒导航沿用[提醒与界面计划](../superpowers/plans/2026-11-12-reminders-and-ui.md)，不抄写施工步骤。

尚未决定是否采纳、模式覆盖、审批超时、卡片布局和排期。现有行为测试入口为 `src/main/agent/loop/plan-tools.test.ts`、`src/main/agent/runtime/adapter/plan-lifecycle.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.plan-lifecycle.test.ts`；它们不能证明本提案已实现。本次未执行。
