# 插件桌面通知宿主

`createElectronPluginNotifications` 在 Electron `app.whenReady()` 后创建，使用系统通知。v2 组合根尚未接入主应用；G38 接线时与现有 v2 服务组合，不调用 v0 宿主或读取旧安装数据：

```ts
const notifications = createElectronPluginNotifications({
  access: pluginId => installedAccess(pluginId),
  onAccessChange: (pluginId, listener) => observeAccess(pluginId, listener),
  focusMainWindow: () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  },
});

// HostDependencies.configureRpc
const configureRpc = (pluginId, rpc) => {
  const disposeServices = services.configureRpc(pluginId, rpc);
  const disposeNotifications = notifications.configureRpc(pluginId, rpc);
  return () => { disposeNotifications(); disposeServices(); };
};
// 组合根退出时调用 notifications.dispose()。
```

以上组合根函数名为接线示意。`access` 必须来自可信安装清单和实时授予，停用时返回 `null`；`revision` 在撤权、重新授予、停用、升级和更换清单时递增。`onAccessChange` 必须同步通知，避免排队展示越过撤权边界。Host 在停止、故障、升级时须调用 `configureRpc` 返回的清理函数。

当前 `toastSoundEnabled` 只控制提醒小窗音效，不能用于禁止通知展示。如果后续存在通知显示开关，通过可选 `isEnabled` 注入；返回 `false` 时不创建系统通知。

纯文本、长度和每插件每分钟 5 次限制与 SDK 测试宿主共用 helper。已授权且参数有效的请求消耗次数，即便系统不支持或显示失败；重连不清空用量。真实插件名始终由宿主加在标题前。点击回调只唤起主窗口，不解析 URL、按钮、图标或执行插件动作。

Electron [`Notification`](https://www.electronjs.org/docs/latest/api/notification) 的 `isSupported()` 不提供跨平台系统通知禁用状态。仅收到 `show` 事件返回 `{ shown: true }`；`failed`、不支持、平台异常和 5 秒未收到确认返回 `{ shown: false }`，关闭未确认通知。系统勿扰和屏蔽不一定触发 `failed`，`show` 也不能证明用户实际看见了横幅。

停用、撤权、升级或连接清理会关闭该连接的通知并移除点击监听。等待中的请求返回权限或取消错误。由于 Electron 不保证所有平台发出 `close` 事件，原生引用最长保留 5 分钟，之后关闭通知，限定资源与点击监听寿命。

验证：`pnpm exec vitest run src/plugins/v2/notifications/index.test.ts`；主进程类型检查：`pnpm exec tsc -p tsconfig.main.json --noEmit`。测试通过注入原生通知工厂验证 RPC 边界，不代表已在打包版或真实操作系统通知中心验收。
