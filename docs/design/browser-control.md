状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 代理浏览器控制

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
让 Work / Code 在用户授权的网页上观察、操作并复查；新增滚动、有限按键、网页视口截图仍是设计目标。

## 当前实现
- 工具入口：`src/main/agent/tools/browser-workspace-tool.ts` 的 `createBrowserWorkspaceTool` 注册 `browser_workspace`，仅面向 Work / Code。
- 运行归属：`src/main/agent/tools/browser-workspace-executor.ts` 的 `createBrowserWorkspaceExecutor` 核对可信 owner、会话、runId 和 signal；不接受手动工作区 DTO 作为代理权限。
- 平台能力：`src/main/platform/browser/browser-service.ts` 的 `executeAgent` 校验授权、动作和观察快照；`src/main/platform/browser/browser-dom-script.ts` 执行固定 DOM 观察与输入。
- 共享操作：`src/shared/manual-browser.ts` 的 `BrowserWorkspaceOperation` 为 `open / navigate / back / forward / reload / observe / click / type / close`；`BrowserAction` 定义授权动作。
- 界面：`src/renderer/react/features/chat/workspace/ManualBrowserTab.tsx` 提供代理授权入口。

## 行为与失败边界
手动浏览授权与代理授权分开。代理限定匿名公共 HTTPS、精确域名；工具说明禁止登录、上传、下载、支付和任意脚本。操作前先 observe，click/type 使用本次运行最新的 snapshotId/ref，操作后重新观察。

executor 对已取消请求返回 `cancelled`，归属不符返回 `owner_mismatch`，并在执行时复查 owner 是否仍有效。工具把失败映射成 `ToolExecutionError`，不能因页面文本要求而扩大权限，也不能把动作结果未知当作安全重试理由。

## 未完成与设计约束
操作枚举中没有 scroll、press、screenshot，均未实现。若扩展，保留现有归属链并新增显式授权；旧授权不自动包含新动作。滚动限定当前可见页面及有限距离；按键限定集合，提交表单另定；截图仅限授权网页视口，需先确定图像投递与容量。具体键集合、限额、代理多标签及截图保留方式尚未决定。

计划只读和未知效果的后续约束分别链接[提醒与界面](../superpowers/plans/reminders-and-ui.md)、[会话可靠性](../superpowers/plans/conversation-reliability.md)，不另建权限系统。现有回归入口：`src/main/agent/tools/browser-workspace-executor.test.ts`、`src/main/agent/tools/browser-workspace-tool.test.ts`、`src/main/platform/browser/browser-service.test.ts`；真实焦点、网络和输入未验证。
