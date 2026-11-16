# 切换会话或刷新会取消正在进行的运行

状态：待修复（负责人 2026-11-16 确认是缺陷；修复进行中，排在“页面接回运行”之前）

## 现象

默认启动下，用户在会话 A 发起运行后：

- 切换到会话 B；
- 刷新聊天页；
- 关闭聊天窗口。

A 的运行都会收到取消请求并停下。用户以为任务还在后台跑，实际上已经被取消。

## 触发条件

1. 默认启动（默认记忆实现接管 Chat、Work、Code 三种模式，包括临时 Chat）。
2. A 的运行正在进行。
3. 页面上报新的活动目标（切换会话），或聊天页主框架导航（刷新），或聊天窗口的 WebContents 销毁（关窗）。

用 `--firefly-memory-controlled` 启动时，只有受控的 Chat 会这样；Work、Code 和档案不匹配的 Chat 不走这条链路。

## 根因（静态核实，真机复现待补）

1. 运行准入时，`src/main/agent/memory-runtime/main-default-memory.ts` 的 `authorizeRun` 把运行的信号绑在页面的桌面记忆授权上（受控模式下是 `main-desktop-memory.ts` 的 `authorizeRun`）。
2. 授权由 `src/main/memory/sources/main-desktop-session-authority.ts` 管理：`refresh()` 要求当前活动目标仍是原会话、原页面，不满足就撤销；主框架导航与 WebContents 销毁经 `src/main/platform/interaction/active-chat-target.ts` 的失效通知撤销全部授权。
3. 切换会话时，`src/main/features/sessions/chat-ui-ipc.ts` 上报新目标，经 `src/main/app/default-dependencies.ts` 的 `onActiveTargetChanged` 调用 `desktopMemory.refresh()`。
4. `src/main/features/chat/agui-bridge.ts` 收到授权撤销后调用 `cancelRun()`。

另外，`src/main/platform/browser/browser-host-owner.ts` 在切换会话、导航时撤销浏览器的 owner，正在使用浏览器工具的运行也可能被切断（待核实）。

已结算预约成功的受控回复不会被稍晚的取消改成取消（`src/main/conversation/transcript/run-settlement.ts`），所以准确说法是“请求取消”。

## 影响范围

- 用户在运行中切换会话或刷新，任务被中止，工具执行到一半停下。
- ChatPage 回归计划里依赖“后台运行继续”的验收（例如施工包 C 的 C5、施工包 G 的后台审批）在默认启动下实际不会发生。
- 刷新后从提醒处理审批（PR #93）在默认启动下暂时用不上，因为审批随运行一起被取消。

## 修复方向

准入看页面，之后归运行：只有正在显示 A 的页面能为 A 发起运行、写入 A 的用户内容；运行被接受后，切换会话、刷新、关窗都不撤销它的授权，只有用户停止、接管、删除会话、应用退出或运行自己结束才停下。页面经 IPC 发起的操作仍按当前页面校验，新页面不能借旧运行的授权扩大权限。

## 相关文件

- `src/main/memory/sources/main-desktop-session-authority.ts`
- `src/main/agent/memory-runtime/main-default-memory.ts`、`main-desktop-memory.ts`
- `src/main/features/chat/agui-bridge.ts`
- `src/main/features/sessions/chat-ui-ipc.ts`、`src/main/app/default-dependencies.ts`
- `src/main/platform/browser/browser-host-owner.ts`
