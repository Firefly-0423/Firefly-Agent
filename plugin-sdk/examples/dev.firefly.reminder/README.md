# dev.firefly.reminder

Firefly 1.2.0 插件 SDK 示例：定时提醒。

## 演示内容

- 清单 `firefly.plugin.json`（`schemaVersion: 1`、反向域名 `id`、声明 `schedules`、`model.generate` 与 `notifications` 权限）。
- 调用 `ctx.schedules.propose` 创建每日重复的 `callback` 定时任务，展示 `pending_approval` 状态与任务列表查询。
- 通过 `ctx.schedules.onTrigger` 响应任务触发，在任务已批准且未取消时调用 `ctx.model.generate` 生成提醒文本，再调用 `ctx.notifications.show` 展示桌面通知。

## 限制

通知需要用户授予 `notifications` 权限，撤销后会静默跳过。系统不支持通知时也不会报错。标题和正文分别截取到 64 和 256 个 Unicode 码点，每个插件每分钟最多 5 条；宿主清理控制字符并为标题加上真实插件名前缀。已展示提醒的生成文字也可以通过 `list_reminders` 查看。
