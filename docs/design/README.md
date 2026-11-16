# Firefly 设计文档索引

状态：设计目录索引
核对基线：`dev/docs-design`，`dc6327a`。

按主责模块分组，跨层链路在各篇列出实际入口。文件名日期沿用本批草稿的 `2026-11-12`，不表示该日完成实现或验收。

- **已实现**：核心行为可在当前代码中定位；不表示本次测试、构建或界面验收通过。可选后续能力仍以正文边界为准。
- **部分实现**：已有产品能力，但文中明确的目标或可靠性保证尚未贯通。
- **设计目标**：只有相邻基础能力，目标流程未实现；不代表已获实施批准。

施工任务和验证进度以 [开发流程](../contributing/development-workflow.md)、[施工计划目录](../superpowers/plans/) 内对应计划及进度为准。已提交的三篇设计保留原文，本文状态按当前代码区分实现程度，不改写其审批或历史记录。

## 跨层架构（L0–L6）

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-main-process-layering.md](2026-11-12-main-process-layering.md) | 主进程七层依赖与模块职责 | 已实现 |

## L1 platform：平台服务

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-attention-toast-center.md](2026-11-12-attention-toast-center.md) | 提醒生命周期与精确定位增量 | 部分实现 |
| [2026-11-12-browser-control.md](2026-11-12-browser-control.md) | 代理浏览器授权、操作与候选动作 | 部分实现 |
| [2026-11-12-code-git-live-refresh.md](2026-11-12-code-git-live-refresh.md) | Git 监听刷新与运行中审查边界 | 部分实现 |

## L2 model / tooling / conversation：模型、工具与会话契约

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-vision-image-routing.md](2026-11-12-vision-image-routing.md) | 图片能力、路由、转述和投递边界 | 部分实现 |
| [2026-11-12-conversation-transcript-architecture.md](2026-11-12-conversation-transcript-architecture.md) | 会话轨迹、活动上下文与展示分工 | 部分实现 |

## L3 knowledge / memory：知识与记忆

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-knowledge-learning-status.md](2026-11-12-knowledge-learning-status.md) | Work 知识工作区、抽查与已有进度更新 | 已实现 |

## L4 agent：智能体运行

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-firefly-harness-loop.md](2026-11-12-firefly-harness-loop.md) | 智能体主循环与运行适配 | 部分实现 |
| [2026-11-12-harness-runtime-boundary.md](2026-11-12-harness-runtime-boundary.md) | 终态、取消、重放和未知副作用 | 部分实现 |
| [2026-11-12-harness-parallel-scheduling.md](2026-11-12-harness-parallel-scheduling.md) | 工具并行、顺序提交与运行快照 | 部分实现 |
| [2026-11-12-plan-mode-permission-and-state.md](2026-11-12-plan-mode-permission-and-state.md) | 计划只读限制与状态恢复增量 | 部分实现 |
| [2026-11-12-plan-approval-in-run.md](2026-11-12-plan-approval-in-run.md) | 同一次运行内提交和等待计划审批 | 设计目标 |

## L5 features：功能入口

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-message-queue.md](2026-11-12-message-queue.md) | 待发消息、认领与安全点插话 | 部分实现 |
| [2026-11-12-workspace-open-files-review.md](2026-11-12-workspace-open-files-review.md) | 从会话使用外部应用打开工作区 | 已实现 |

## L6 app：组合根

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-main-process-composition-root.md](2026-11-12-main-process-composition-root.md) | 启动装配、就绪、降级与退出 | 已实现 |

## 渲染端与 preload

| 文档 | 主题 | 状态 |
|---|---|---|
| [2026-11-12-chatpage-architecture.md](2026-11-12-chatpage-architecture.md) | 聊天页职责、生命周期与回归矩阵 | 部分实现 |
| [2026-11-12-live-candidate-answer.md](2026-11-12-live-candidate-answer.md) | 候选预览、过程归类与正式正文 | 已实现 |
| [2026-11-12-runtime-unified-view.md](2026-11-12-runtime-unified-view.md) | 运行时间线、步骤分组与终态展示 | 已实现 |
| [2026-11-12-tool-display-names.md](2026-11-12-tool-display-names.md) | 工具展示名传递与本地化回退 | 已实现 |
| [2026-11-12-project-session-sidebar.md](2026-11-12-project-session-sidebar.md) | 项目、会话分组与修订布局存储 | 已实现 |
| [2026-11-12-right-panel-layout.md](2026-11-12-right-panel-layout.md) | 右侧面板停靠、尺寸与身份 | 已实现 |
| [2026-11-12-workspace-file-and-diff-panels.md](2026-11-12-workspace-file-and-diff-panels.md) | 当前文件、人工编辑与运行审查快照 | 已实现 |
| [2026-11-15-preload-bridge-split.md](2026-11-15-preload-bridge-split.md) | preload 桥按功能域拆分 | 部分实现 |
| [2026-11-15-settings-page-split.md](2026-11-15-settings-page-split.md) | 设置页入口职责拆分 | 部分实现 |

L0 基础能力随分层及组合根设计说明；本批没有独立 L0 主题。L3 记忆的默认实现仍在当前代码中，本批未保留缺少对应产品链的独立新记忆提案，不据此推断默认记忆缺失。
