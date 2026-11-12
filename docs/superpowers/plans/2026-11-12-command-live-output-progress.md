# 命令实时输出施工进度

状态：未开工
施工计划：[2026-11-12-command-live-output.md](./2026-11-12-command-live-output.md)

本文是交接入口。每完成一个任务就更新下面各节；换会话或换人时先读这里，再读施工计划。

## 1. 当前状态

- 分支：`dev/firefly-1.2.0`（尚未建施工分支）
- 进行到：未开工
- 工作区：—

## 2. 已完成项

无。

## 3. 未完成项

| 施工包 | 任务 | 状态 |
|---|---|---|
| A 落实 1.2.0 数据目录前置条件 | A1 切换正式目录至 `%APPDATA%\Firefly-1.2.0` 并验证隔离、A2 同步开发启动隔离文档测试与 README | 未开始（若公共启动隔离已合入则核对后跳过） |
| B 共享输出契约与尾窗 | B1 Unicode 码点尾窗与 `applyCommandOutput`、B2 `normalizeCommandOutput` 与 `ToolExecutionRecord` 挂载 | 未开始（依赖 A） |
| C 前台执行输出、解码、事件链与取消收尾 | C1 双流增量解码与 100ms 批处理及 GBK 重建、C2 `tool-context` 与 `run-shell-tool` 接入、C3 `tool-dispatcher` / `event-mapper` / `harness-adapter` 取消收尾 | 未开始（依赖 B） |
| D 聊天状态、检查点和持久化 | D1 事件过滤与序号校验及终态保留、D2 350ms 最大等待检查点与 `chats-store` 读写规范化 | 未开始（依赖 B、C） |
| E 命令面板、ANSI 安全渲染与三种模式展示 | E1 锁定 ANSI 依赖与 `command-output-presentation` 及 i18n、E2 `CommandOutputPanel` 组件、E3 接入 `ChatMessageList` 与 `WorkspaceRunResults` | 未开始（依赖 B、D） |
| F 伙伴前台命令与整链回归 | F1 扩展 `TaskSession` / `ToolTaskResult` / `task-session-store`、F2 子任务 `firefly.task.command_output` 窄回调与隐私隔离、F3 控制器委派归属与整链集成测试 | 未开始（依赖 C、D、E） |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| 全量测试 `npm test` | — | — |
| 类型检查与构建 | — | — |
| 存储边界检查 `npm run check:storage-boundary` | — | — |
| 真机验证 | — | — |

## 5. 偏离计划

无。
