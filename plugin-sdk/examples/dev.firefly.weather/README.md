# dev.firefly.weather

Firefly 1.2.0 插件 SDK 示例：天气查询。

## 演示内容

- 清单 `firefly.plugin.json`（`schemaVersion: 1`、反向域名 `id`、声明 `network` 风险工具与 `secrets` 权限、设置面板 `ui/settings.html`）。
- 城市参数校验（拒绝空值、超长字符串、控制字符与 URL 保留符号，且不触发 `secrets` 或 `fetch`）。
- 完整工具四态结果：网络请求失败返回 `{ status: "failed", error }`；超时返回 `{ status: "failed", error, retryable: true }`；取消返回 `{ status: "not_executed", reason }`。
- 通过 `ctx.secrets` 读取/保存/清除 API Key，并通过 `ctx.ui.onMessage` 响应设置面板消息。
