# dev.firefly.reminder

Firefly 1.2.0 插件 SDK 示例：定时提醒。

## 演示内容

- 清单 `firefly.plugin.json`（`schemaVersion: 1`、反向域名 `id`、声明 `schedules` 与 `model.generate` 权限）。
- 调用 `ctx.schedules.propose` 创建每日重复的 `callback` 定时任务，展示 `pending_approval` 状态与任务列表查询。
- 通过 `ctx.schedules.onTrigger` 响应任务触发，在任务已批准且未取消时调用 `ctx.model.generate` 生成提醒文本。

## 限制

SDK 1.2.0 还没有桌面通知接口，所以本示例不会弹出通知。生成的提醒文字只留在插件进程内，用 `list_reminders` 查看。等宿主提供通知能力后，本示例再接入。
