# @firefly/plugin-sdk

Firefly 插件开发工具包。公开契约、校验与测试工具均由本仓库构建。

主应用的安装、重启更新、失败恢复与数据保留规则见 [生命周期说明](LIFECYCLE.md)。

## 安装

```bash
npm run build:plugin-sdk
npm pack ./packages/plugin-sdk
```

## 用途

- **类型**：`import type { PluginContext, PluginTool, ... } from "@firefly/plugin-sdk"` —— 全部公开契约类型。
- **常量**：`CURRENT_PLUGIN_API_VERSION`、`PLUGIN_CAPABILITIES`、`PLUGIN_HOST_ERROR_CODES`。
- **Manifest 校验**：`validateManifestData(data)` —— 用与宿主同一份 JSON Schema 校验结构、类型、枚举与必填字段；API 版本兼容、ID/SemVer 格式及入口文件检查由宿主加载器完成，纯数据校验通过不代表可安装。
- **测试工具**：`import { createMockPluginContext, assertPluginTool, assertValidManifest } from "@firefly/plugin-sdk/testing"` —— 脱离宿主的 Mock Context 与契约断言。

在插件项目使用 `npm install /path/to/firefly-plugin-sdk-0.2.0.tgz` 安装上述本地产物；这是本地包名，不表示已发布到 npm。

SDK 包含公开类型、常量、Manifest 校验及测试工具，不包含 Electron、React 或 Firefly 宿主运行时。仅使用 `import type` 的插件编译后不依赖 SDK；如果入口实际导入 `isPluginHostError`、常量或校验函数，必须随插件打包这些运行时代码及所需依赖，不能只复制编译入口后省略它们。

Mock Context 的 `dispose()` 触发取消与登记的清理回调，不会代替插件调用 `unregister()`，也不模拟真实文件存储、Electron 窗口或渠道注册。

接口定义见 `src/`。

## 当前 0.2.0 源码契约

提示词 Provider 通过 `sources` 声明参与的活动场景：

- 可选值为 `conversation`、`scheduler`、`plugin-agent`，所有场景都携带 `mode` 并按 `modes` 过滤。
- 未声明 `sources` 的既有 Provider 只参与会话与定时任务；插件无头目标循环必须显式声明 `plugin-agent`。
- 已退役的动态发帖来源不再接受注册；旧插件应移除该声明并重新构建。

```ts
ctx.registerPromptProvider({
  id: "memory-context",
  sources: ["conversation", "scheduler"],
  provide({ source, mode, userText }) {
    return `当前会话模式：${mode}`;
  },
});
```
