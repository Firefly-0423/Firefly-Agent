状态：设计提案（现状整理）
实现状态：已实现

# Firefly 右侧工作区面板布局

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
在右侧同时查看文件、差异、计划、任务和浏览器，支持拖动停靠与尺寸调整；布局不改变文件授权或运行事实。

## 当前实现
`src/renderer/react/features/chat/pages/ChatPage.tsx` 管理外层尺寸、打开项及会话切换清理；`src/renderer/react/features/chat/components/ChatPageInspector.tsx` 装配内容；`src/renderer/react/features/chat/components/RightInspector.tsx` 的 `RightInspector`、`InspectorTab` 管理列、行、拖动和放大；纯布局运算位于 `src/renderer/react/features/chat/components/panel-layout.ts`。

类型名仍为 InspectorTab，实际是可并排、上下停靠的面板。文件树 ID 为 files，当前文件按相对路径复用，差异按运行及路径等身份区分；计划按会话区分。数据来源和编辑权限见[文件与差异](2026-11-12-workspace-file-and-diff-panels.md)。

## 行为与失败边界
标题支持 Alt+方向键移动，分隔条支持方向键调尺寸，聚焦标题时 Delete 关闭，拖动中 Escape 取消；嵌套编辑器按其本身键盘语义处理。放大保留其他面板挂载。会话或模式改变时页面清理相关打开项，浏览器有独立生命周期。

内部 saved 列布局是组件状态，不能据此外推全部打开项、放大和排列跨重启恢复。仅以 activeSessionId/mode 为依赖的清理也不能证明同会话更换工作区根时全部项一定清空；访问仍须 Main 重新核对绑定。布局运算不执行文件恢复或审批。

## 未完成与维护
内部排列持久恢复、同会话换根保留策略和独立浮窗尚未决定。命令展示采用[命令实时输出计划](../superpowers/plans/2026-11-12-command-live-output.md)，性能采用[提醒与界面计划](../superpowers/plans/2026-11-12-reminders-and-ui.md)。

现有测试：`src/renderer/react/features/chat/components/RightInspector.behavior.test.ts`、`src/renderer/react/features/chat/components/panel-layout.test.ts`。本次未执行；原生浏览器拖放、焦点、窄窗、多屏和屏幕阅读器未验收。
