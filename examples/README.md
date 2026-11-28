# 插件示例说明

本目录的前几个插件用于阅读 API 与集成方式。源码、manifest 和署名保持原样；不把注册冒烟等同于真实宿主验证。末尾的“随市场目录分发”五个插件是离线工具，由 `scripts/plugin-marketplace/build.mjs` 打成 `.ffplugin` 并写入离线目录，发布方式见 `docs/plugin-catalog-publishing.md`。

| 目录 | 入口与依赖 | 展示内容 |
| --- | --- | --- |
| `system-status/` | `index.cjs`；无 `deps` | 状态与磁盘工具、独立窗口 `ui.html`、设置面板 `panel.html`、`snapshot` IPC；manifest 作者为 `wu02`，版本 `0.2.0` |
| `weather-tool/` | `index.ts`；`secrets` | 读取 `openweathermap_key`、OpenWeather 请求失败或未配密钥时改用 Open-Meteo、城市缓存 |
| `long-term-memory/` | `index.ts`；`llm`、`conversations` | 监听 `host:turn:finished`、读取消息、摘要、动态 Provider |
| `scheduled-automation/` | `index.ts`；`scheduler` | 自有任务创建、列出、更新、删除；创建即停用，用户在宿主启用 |

### 随市场目录分发的离线插件

这五个插件都只做内存内计算：不联网、不读写文件、不启动命令，首次安装保持停用。1.2.0 清单禁止工具声明 `safe`，所以每个工具按最低的真实风险档声明 `fs-read`，调用时会按该档走审批。每个目录含 `firefly.plugin.json`（1.2.0 清单，id 为 `dev.firefly.<目录名>`）、`index.mjs`、`README.md`、`LICENSE`，以及只供目录条目使用、不进入包的 `catalog.json`；构建产出 `.ffplugin` 包和 v2 `registry.json`。测试在 `scripts/plugin-marketplace/`，运行 `pnpm run test:plugin-marketplace`。

| 目录 | 工具 | 来源 |
| --- | --- | --- |
| `text-stats/` | `text-stats_count` | Firefly 文本统计插件（MIT），由插件面板按需加载 |
| `json-tools/` | `json-tools_validate`、`json-tools_compare` | 改编自 deepseek-harness `packages/util/values`（MIT） |
| `timezone-tools/` | `timezone-tools_canonicalize`、`timezone-tools_convert` | 校验规则改编自 deepseek-harness `packages/util/time`（MIT）；换算为 Firefly 新写 |
| `code-language/` | `code-language_detect` | 改编自 deepseek-harness `packages/util/code-language`（MIT） |
| `text-trim/` | `text-trim_cap` | 改编自 deepseek-harness `packages/util/output-retention`（MIT） |

## 构建与安装

在仓库根目录，现有命令为：

```bash
pnpm run build:plugin-sdk
npm pack ./plugin-sdk
pnpm run test:plugin-examples
```

前两条生成本地 SDK tarball；在插件项目通过 `npm install /path/to/firefly_wu-plugin-sdk-<版本>.tgz` 安装；已发布的版本也可以直接 `npm install @firefly_wu/plugin-sdk`。

`test:plugin-examples` 自行构建 SDK，在临时项目安装 tarball，编译四个 TypeScript 示例，将各自 `dist/index.js` 复制为 manifest 要求的 `index.cjs`，然后运行 `scripts/plugin-sdk/smoke-examples.mjs`。结束会删除临时项目与该脚本生成的 tarball，不会留下可安装 ZIP，也不启动 Electron。

手工分发 TypeScript 示例时，把编译后的 `index.js` 作为 `index.cjs` 与原 `manifest.json` 放在同一插件目录再压缩。四个入口仅导入 SDK 类型；实际导入 SDK 函数的其他插件须一并打包运行时代码和依赖。`system-status` 的 JS 入口、两个 HTML 文件及图标直接随目录打包。

导入位置：聊天窗口插件面板添加 ZIP，首次导入保持停用，用户明确启用后加载。接口以 `plugin-sdk` 为准。

## 当前源码限制

示例验证入口为 `pnpm run test:plugin-examples` 与 `src/plugins/examples-lifecycle.test.ts`（覆盖 `unregister()` → `dispose()` 真实顺序与 JSON 持久化往返）。Mock 验证不代表真实外部服务或 GUI 通过。

- `system-status`：CPU 与网络速率采用前后两次采样差分，首次调用或停用重启后的第一次采样因缺少基准返回 `null`；GPU 依赖本机命令，Windows 采集依赖 PowerShell。未传盘符时会按环境变量或系统 WMI 动态发现系统盘。
- `weather-tool`：`secrets.get()` 抛错会使注册失败；只有缺少密钥或 OpenWeather 请求失败才进入免密钥路径。
- `long-term-memory`：依赖宿主提供完整 `getMessages` 游标分页；真实 LLM 摘要质量取决于宿主模型服务，离线或调用失败时退回截断摘要。
- `scheduled-automation`：宿主仍通过插件所有权校验限制任务访问，示例没有启用任务的接口。

停止顺序依据 `src/plugins/manager.ts`：`beginStop()` → 插件 `unregister()` → context `dispose()`。真实存储依据 `src/plugins/storage.ts` 的 `JSON.stringify` / `JSON.parse`；`plugin-sdk` 里的 `createMockPluginContext` 与 `scripts/plugin-sdk/smoke-examples.mjs` 当前以进程内 Map 保存原值且未按真实停止顺序调度，真实持久化与生命周期行为以 `src/plugins/examples-lifecycle.test.ts` 为准。
