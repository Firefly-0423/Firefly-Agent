# @firefly_wu/plugin-sdk

Firefly 1.2.0 插件开发工具包。公开契约类型、`definePlugin`、错误类型、测试宿主 `createTestHost()` 与 `firefly-plugin` CLI 均由本仓库构建。

## 安装

```bash
npm install @firefly_wu/plugin-sdk
```

从本仓库源码构建：

```bash
pnpm run build:plugin-sdk
npm pack ./plugin-sdk
```

## 导出入口

- **`@firefly_wu/plugin-sdk`**：
  - `definePlugin(plugin)`
  - `PluginError`、`PLUGIN_ERROR_CODES`、`PluginErrorCode`
  - `PluginContext`、`Mode`、`RunSource`、`ToolRisk`、`Disposable` 及各项能力接口类型（`Tools`、`ContextProviders`、`Channels`、`Model`、`Events`、`Sessions`、`Workspace`、`Schedules`、`Secrets`、`Ui`）
- **`@firefly_wu/plugin-sdk/testing`**：
  - `createTestHost(options)`：模拟三种运行模式（`chat`、`work`、`code`）、三种权限档位（`read-only`、`per-action`、`full`）、权限声明与撤销、取消、进程崩溃，并记录插件发起的每一次调用（`host.calls`）。
- **`firefly-plugin` CLI**：
  - `firefly-plugin validate <dir>`：校验 `firefly.plugin.json` 清单与包边界。
  - `firefly-plugin pack <dir> -o <file.ffplugin>`：校验并打包为 `.ffplugin`。
