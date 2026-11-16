状态：设计提案（现状整理）
实现状态：部分实现

# Firefly Code Git 自动刷新

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
外部文件与 Git 元数据变化后自动更新 Code 面板；区分当前仓库状态与本次运行的审查证据。运行中 Review 预览仍是可选目标。

## 当前实现
`src/main/platform/git/git-service.ts` 的 `GitService` 从会话解析工作区，`src/main/platform/git/git-workspace-watcher.ts` 的 `createGitWorkspaceWatcher` 共享底层监听、维护订阅引用并合并事件。默认尾防抖 300ms、持续事件最长等待 2000ms；这是调度参数，不是端到端延迟保证。最后一个引用释放后清理监听，组合根负责 dispose。

`src/main/platform/git/code-git-ipc.ts` 校验聊天主窗口及 mainFrame，越权返回 `CODE_GIT_FORBIDDEN`。变更经 `CODE_GIT_CHANGED` 送达 `src/renderer/react/features/chat/components/CodeGitPanel.tsx`；`src/renderer/react/features/chat/components/code-git-refresh.ts` 的 `createCodeGitRefreshController` 同时只读一次，加载期间的通知合并为一次补刷，dispose 后忽略迟到结果。手动刷新保留，监听错误促使重新读取。

## Review 的行为与失败边界
`src/main/agent/review/run-review-tracker.ts` 的 `finalizeReview` 形成运行结束快照；`src/main/agent/runtime/agent-loop-adapter.ts` 在收尾调用。`src/renderer/react/features/chat/components/ChatMessageList.tsx` 依据结束状态展示审查，`src/renderer/react/features/chat/components/ReviewPanel.tsx` 读取并有限重试。

当前 Git 自动刷新不能证明 Review 在运行中持续更新；仓库脏文件也不能直接当作本轮成果。快照捕获范围有限，取消不回滚文件。读取失败不应由界面伪造已完成变更。

## 未完成与设计选择
可选运行中预览需 Main 根据已归属当前 run 的证据生成，绑定会话、修订和终态；不能高频调用具有最终落盘语义的 finalizeReview。终态后迟到预览不得覆盖最终快照，重开不从当前 Git 重算历史结果。是否做预览、是否只限 Code、是否默认三行展示均未决定，不能写成已交付。

运行事实和恢复沿用[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)，展示证据详见[文件与差异](workspace-file-and-diff-panels.md)。现有测试：`src/main/platform/git/git-workspace-watcher.test.ts`、`src/main/platform/git/code-git-ipc.test.ts`、`src/renderer/react/features/chat/components/code-git-refresh.test.ts`、`src/renderer/react/features/chat/components/CodeGitPanel.subscription.test.ts`。本次未运行监听、真实 Git 操作或性能测量。
