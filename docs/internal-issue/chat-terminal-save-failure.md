# Agent 终态持久化失败时误存空正文并错误发送已落盘回执（已修复）

状态：已修复（PR #90 / `4683aae`；真机造障尚未实测）
日期：2026-11-16

## 现象

在 ChatPage 回归施工包 A（任务 A10）复核过程中发现：当 Agent 运行结束并写入终态检查点发生暂时性失败或存储拒绝时，`AgentRunController` 旧实现把终态写入放在运行的通用异常处理中，造成四类错误结果：

1. 写入失败一次后再次成功时，误写入空正文和 `terminalStatus: "success"`，同时界面却错误显示任务失败，并照常发出 `AGUI_RUN_PERSISTED` 回执；
2. 写入一直失败时，界面上的已生成正文被清空；
3. 存储返回 `null` 时界面既无“没能保存”提示，仍旧向主进程发回 `AGUI_RUN_PERSISTED`；
4. 失败运行本身终态写不进去时无法同时保留两类错误提示且误发回执。

## 触发条件或复现步骤

1. Agent 运行生成了非空回答并到达终态（`RUN_FINISHED` 或失败路径 / 会话冲突路径）。
2. `chatsStore.upsert` 发生暂存文件写入抛错（如 `.tmp` 被占住）、返回 `null` 或返回值缺失该消息条目。
3. 在修复前运行 `AgentRunController.test.ts` 中 A10 新增的 5 个写入拒绝用例，5 个全部失败（`docs/superpowers/plans/2026-11-12-chatpage-regression-progress.md` §2 A10）。

## 影响范围

- **受影响组件**：渲染端 `AgentRunController` 终态落盘与持久化回执流程（正常、失败与会话冲突三条分支）。

## 根因

终态写盘原本耦合在运行主流程异常捕获块里：首次 `upsert` 异常后走失败分支重建快照并覆盖已生成的 `savedAnswer`，也没有核对 `upsert` 返回的会话中确实包含目标 `snapshot.id` 就触发了 `reportRunPersisted()`。

## 当前状态

- **已修复**：PR `#90`（`4683aae`，分支 `fix/chat-terminal-save`，2026-11-15 合入）重构 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`：
  - 将终态持久化收口至 `settleTerminalSave()` 与 `persistTerminal()`，成功、失败、会话冲突三条终态路径统一调用；
  - 冻结同一份 `terminal` 快照，抛错后最多额外重试两次（间隔 `100ms`、`300ms`），不重跑模型；
  - 严格检查存储返回值 `Boolean(saved?.messages?.some((entry) => entry.id === snapshot.id))` 确认落盘后才调用 `refreshCanonicalSettlement()` 与 `reportRunPersisted()`；返回 `null` 或缺消息时不重试、不发回执；
  - 最终写入失败时保留界面正文并在过程信息中添加国际化失败提示 `chatPage.terminalSaveFailed`（已补中英文）。
- **真机待补**：`2026-11-12-chatpage-regression-progress.md` §5 注明本次只在单元测试替身中验证并完成反向改坏检查，真机环境制造磁盘写入失败尚未实测（归施工包 F 阶段）。

## 相关文件

- `docs/superpowers/plans/2026-11-12-chatpage-regression-progress.md`（§2 A10、§5 偏离计划）
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`（`settleTerminalSave`、`persistTerminal`）
- `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`
- `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`
- 修复提交：PR `#90`（`4683aae`）
