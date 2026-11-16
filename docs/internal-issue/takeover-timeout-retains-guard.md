# 接管超时后旧运行仍占着会话守卫，界面侧停止状态与提示待补

状态：待修复（主进程守卫行为已由 PR #91 定型保留；界面侧停止等待与提示待另开 PR）
日期：2026-11-16

## 现象

当会话中存在尚未结算的旧运行、用户触发“终止并重开”（携带 `takeoverFromRunId`）接管时，若旧运行在默认接管等待时限（两次各 `5000ms`，总计 `10000ms`）内未能完成结算，主进程拒绝启动新运行并返回 `SESSION_RUN_TAKEOVER_STUCK:<runId>`；主进程仍将旧运行保留在 `runsByConversation` 守卫中，直至其真正结算。在界面侧，PR `#91` 合并时明确未包含超时后的界面收尾：接管卡片与界面状态没有统一结束等待、给出“旧任务尚未停止，未启动新任务”提示、暂停自动派发或停止接管按钮转圈。

## 触发条件或复现步骤

1. 在某个会话 `conversationId` 中存在一个活跃运行（`runsByConversation` 已登记该 `incumbent.runId`），且该运行进入取消无效或迟迟不结算的状态（例如进入 `SRunSettlementGate` 非 `"open"` 提交阶段，取消请求不再触发 abort）。
2. 客户端以 `takeoverFromRunId = incumbent.runId` 发起接管运行，调用 `src/main/features/chat/agui-bridge.ts`。
3. 主进程调用 `incumbent.abort()` 并等待 `takeoverWaitMs`（默认 `5000ms`）最多两次（`attempts >= 2`）。
4. 旧运行仍未结算，主进程抛出 `SESSION_RUN_TAKEOVER_STUCK:<incumbent.runId>`，旧运行仍保留在 `runsByConversation` 中。
5. 对界面侧而言，PR `#91`（施工包 B 的 B4）仅覆盖主进程守卫与超时契约（`agui-bridge.test.ts`），未实装超时后界面停止转圈与专属文案分支。

## 影响范围

- **受影响范围**：工具写入或终态持久化卡住、导致旧运行超过 10 秒未结算时的桌面会话接管路径。
- **行为边界**：若旧运行后续迟到完成结算，守卫随之释放，之后重新发送可恢复正常；但在旧运行结算之前，同一会话的互斥守卫会继续拒绝新运行（`hasActiveConversationRun()` 仍为 `true`）。

## 根因

1. **主进程刻意保留旧守卫的原因**：在 `src/main/conversation/transcript/run-settlement.ts` 中，`SRunSettlementGate.requestCancel()` 在 `phase !== "open"` 时返回 `false`（进入终态提交后取消不再中止落盘）；`src/main/features/chat/agui-bridge.ts` 若在接管超时后强行摘除守卫，会让新运行在旧运行仍可能写盘期间并发进入同一会话，违反会话唯一所有者约束。
2. **界面侧未收尾的原因**：`docs/superpowers/plans/2026-11-12-chatpage-regression-progress.md` §5 明确将 B4 “无悬空 busy”拆为两条：主进程保持互斥守卫（已在 PR `#91` 验收），而界面侧处理超时（结束等待、显示“旧任务尚未停止，未启动新任务”、暂停自动派发、让接管按钮不再一直转圈）另开 PR 解决，未放进施工包 B。目前 `src/renderer/react/features/chat/pages/ChatPage.tsx` 与 `AgentRunController.ts` 尚未处理该专属界面分支。

## 当前状态

- **主进程侧（已定型）**：PR `#91`（`dc6327a`）已合入并锁死 B4 行为——超时只产生一次旧运行调用、不启动新运行、不强制放锁、旧运行迟到结算后允许重提。
- **界面侧（待修复）**：待另开 PR 实现接管超时的界面提示、暂停自动派发及结束接管按钮等待状态。

## 相关文件

- `docs/superpowers/plans/2026-11-12-chatpage-regression-progress.md`（§2 B4、§5 偏离计划）
- `src/main/features/chat/agui-bridge.ts`（`SESSION_RUN_TAKEOVER_STUCK`、接管等待循环）
- `src/main/conversation/transcript/run-settlement.ts`（`SRunSettlementGate.requestCancel`）
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`
- `src/renderer/react/features/chat/pages/ChatPage.tsx`
- 提交与 PR：PR `#91`（`dc6327a`）
