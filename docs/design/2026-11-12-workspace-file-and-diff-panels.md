状态：设计提案（现状整理）
实现状态：已实现

# Firefly 当前文件、编辑与运行差异

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
区分当前磁盘内容、用户编辑草稿和已经捕获的运行差异，避免用当前状态改写历史执行证据。

## 当前实现
| 数据 | 入口与关键类型 |
|---|---|
| 当前文件 | `src/main/features/sessions/workspace-files-ipc.ts` 的 `listDirectory`、`readFile` 按会话绑定访问；`src/renderer/react/features/chat/components/FileTreePanel.tsx` 展示目录、源码和预览。 |
| 人工编辑 | `src/main/features/sessions/workspace-file-editor.ts` 的 `inspectWorkspaceText`、`saveWorkspaceText` 处理版本与单次确认；不是代理写入的通用豁免。 |
| 运行审查 | `src/main/agent/review/run-review-tracker.ts` 的 `RunReviewTracker.captureBefore`、`finalizeReview` 保存 `src/shared/review-types.ts` 的 `ReviewSnapshot`。 |
| 差异展示 | `src/renderer/react/features/chat/components/ReviewInspector.tsx` 读取快照；`src/renderer/react/features/chat/workspace/WorkspaceRunResults.tsx` 优先快照、缺失时回退工具证据；`src/renderer/react/features/chat/workspace/CodeDiff.tsx` 渲染行差异。 |

## 行为与失败边界
Main 重取工作区绑定，真实路径越界返回 OUT_OF_ROOT；目录最多 1000 项且标记截断。预览上限 1 MiB，文件头 4096 字节的 NUL 占比超过 5% 返回 BINARY；目录、过大和缺绑定分别有明确失败。IPC 核对聊天主窗口及 mainFrame，显示隐藏项过滤不是额外授权系统。

编辑草稿留在应用内存，保存复查 editVersion 并逐次系统确认；冲突返回 CONFLICT，拒绝返回 CANCELLED，不覆盖新版本。预览不等于保存授权，文件读取检查也不能描述为绝对没有竞态。

运行快照只覆盖接入捕获的路径，不能证明任意 Shell、插件或外部编辑器的全部改动；当前文件刷新不应替换旧快照。大文件、二进制或截断证据可能只展示元数据，取消和失败不自动回滚文件。

## 未完成与维护
专用上一处/下一处差异导航、运行中自动打开差异尚未实现或定案。面板布局见[右侧布局](2026-11-12-right-panel-layout.md)；运行中预览见[Git 自动刷新](2026-11-12-code-git-live-refresh.md)；命令展示由[命令实时输出计划](../superpowers/plans/2026-11-12-command-live-output.md)承接。

现有测试：`src/main/features/sessions/workspace-files-ipc.test.ts`、`src/main/features/sessions/workspace-file-editor.test.ts`、`src/main/agent/review/run-review-tracker.test.ts`、`src/renderer/react/features/chat/workspace/CodeDiff.test.ts`。本次未执行；链接平台前提、原生句柄、真实保存拒绝和窄窗未验收。
