# Chat 模式仍监听并允许延迟 Plan 事件（待 C12 落地）

状态：待修复（已列为 ChatPage 回归计划施工包 C12 任务，当前尚未施工）
日期：2026-11-16

## 现象

尽管负责人已于 2026-11-13 决定 Chat 模式不应进入计划模式、且渲染页的 `conversation-run-policy.ts` 后续需要按“Chat 仅限普通对话模式”收口，目前代码中的 `shouldListenForDeferredPlanEvents("chat")` 仍然返回 `true`，现有单元测试也将 `"chat"` 视为支持 Plan 事件的模式。

## 触发条件或复现步骤

1. 在 Chat 模式下打开或恢复聊天会话。
2. 查看 `src/renderer/react/features/chat/pages/conversation-run-policy.ts`（第 3–6 行）：
   ```ts
   export function shouldListenForDeferredPlanEvents(mode: ConversationMode): boolean {
     const supportsPlans = mode === "code" || mode === "chat";
     return supportsPlans;
   }
   ```
3. 与之对应的 `ChatPage.test.ts` 表驱动用例当前仍断言 `mode === "chat"` 返回 `true`。

## 影响范围

- **受影响模式**：桌面 Chat 模式。
- **影响边界**：Chat 模式会订阅本应仅归属于 Code 模式的延迟计划事件流；在计划事件到达时可能与后续统一“Chat 不进入计划模式”的策略冲突。

## 根因

`docs/superpowers/plans/chatpage-regression-progress.md` §0（2026-11-15 开工前复核）记录：负责人 2026-11-13 的决定在计划写成时尚未落地到代码与既有测试；相关修改已被排入尚未施工的 **施工包 C 的 C12（Chat 不进入计划模式）**。

## 当前状态

- **待修复**：排期于 `docs/superpowers/plans/chatpage-regression-progress.md` §3 施工包 C（`- [ ] C12 Chat 不进入计划模式`），施工时须同步修改 `conversation-run-policy.ts` 与 `ChatPage.test.ts` 的表驱动期望值。

## 相关文件

- `docs/superpowers/plans/chatpage-regression-progress.md`（§0 开工前复核、§3 C12）
- `docs/superpowers/plans/chatpage-regression.md`
- `src/renderer/react/features/chat/pages/conversation-run-policy.ts`
- `src/renderer/react/features/chat/pages/ChatPage.test.ts`
