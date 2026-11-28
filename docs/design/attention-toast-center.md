状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 提醒中心与定位边界

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
把等待用户操作和任务完成集中提醒，同时避免重播造成重复卡片。窗口激活与直达具体交互是不同能力。

## 当前实现
| 职责 | 实现与行为 |
|---|---|
| 事件契约 | `src/main/platform/interaction/toast-events.ts` 的 `ToastEventMap` 汇聚审批、选择、抽查、计划与定时任务事件。 |
| 生命周期 | `src/main/platform/toast/toast-service.ts` 的 `createToastService` 分开维护 `visible`、`seenKeys`、`planRuns`；消隐不等于业务结算。 |
| 窗口 | `src/main/platform/toast/toast-window.ts` 的 `createToastWindowController` 在有内容时使用 `showInactive()`，空列表隐藏。 |
| 接线 | `src/main/app/default-dependencies.ts` 注入事件、设置和窗口激活；目标类型为 `src/shared/toast-types.ts` 的 `ToastTarget`。 |

## 行为与失败边界
计划运行与普通选择去重互斥；成功定时任务的普通通知按 `src/main/platform/toast/types.ts` 的超时移除，失败任务不走同一成功通知。声音有合并窗口，但普通通知后到达的等待操作提醒仍可追加提示音，不能承诺任何到达顺序都只响一次。

点击只上传条目 ID，Main 从保存目标导航，不批准或作答。当前目标只有会话和窗口，不能直达审批、抽查或任务的具体运行记录。操作 IPC 有 Toast 来源守卫，`TOAST_GET_ALL` 当前没有使用同一守卫。

## 未完成与施工入口
精确目标、就绪投递、过期目标提示及读写来源校验由[提醒与界面计划](../superpowers/plans/reminders-and-ui.md)和[进度](../superpowers/plans/reminders-and-ui-progress.md)承接。严格单次音效聚合未定，不写成现有保证。

已有测试入口：`src/main/platform/toast/toast-service.test.ts`、`src/main/platform/toast/toast-window.test.ts`。多屏、不抢焦点和真实定时任务尚未在本次验证。
