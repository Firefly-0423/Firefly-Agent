# Firefly 插件作者须知

本文说明编写与分发 Firefly 插件时的**信任边界、权限档位、数据与密钥存储**及**发布流程**。从零创建插件和调用当前 SDK 接口，见 [plugin-dev-guide.md](./plugin-dev-guide.md)。

## 1. 信任模型：启用即信任插件代码

- **当前版本（`apiVersion: 1`，SDK `0.2.1`）**：插件由 `src/plugins/loader.ts` 加载并在主进程直接执行 Node.js 代码，具备主应用同级权限。`deps` 声明只是宿主服务（`llm`、`conversations`、`secrets`、`workspace`、`scheduler`、`channels`）的注入声明，**不是执行沙箱**；版本目录隔离、代码树摘要与来源记录也**不构成代码运行沙箱**（见 [plugin-sdk/LIFECYCLE.md](../../plugin-sdk/LIFECYCLE.md)）。
- **安装默认停用**：无论是通过本地 ZIP 还是插件市场安装，首次安装后均保持停用，不会执行插件入口；只有在用户确认可信并手动启用后，宿主才调用 `register(ctx)`。
- **来源校验与接管限制**：主应用启用 `PluginVersionStore`（`src/main/features/plugins/host/plugin-runtime.ts`）跟踪包来源与 ZIP SHA-256：
  - 市场来源固定校验 `MARKET_REGISTRY_URLS` 与 `MARKET_ZIP_URL_PREFIXES`（`src/main/features/plugins/host/plugin-marketplace.ts`），核对条目固定 SHA-256 后才解包。
  - 已存在同 ID 插件时，禁止不同已知来源静默接管；从本地或离线目录转为在线市场来源需在宿主原生确认对话框中显式确认。
  - 在设置页中，`settingsPanel` 运行在 `firefly-plugin://` 协议的受限 iframe 中，仅在插件实际处于运行状态时挂载，停用或卸载时销毁 iframe 并拒绝旧桥接调用（`src/main/features/plugins/panel/plugin-panel-protocol.ts`、`src/main/features/plugins/host/plugin-runtime.ts`）。
- **1.2.0 规划演进**（详见 [2026-11-12-plugin-sdk-1-2-0.md](../superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md) §5.1、§9、§14）：
  - 1.2.0 计划将已启用插件移入独立 Electron `utilityProcess`（不继承宿主密钥/环境凭据），但负责人已明确：**进程隔离保护的是宿主稳定性与宿主内部数据，仍非系统级安全沙箱**，插件进程依然具备 Node 文件系统与网络访问能力，因此仍坚持“启用即信任该插件的代码”。
  - 包含 `.node` / `.dll` 原生模块（`native: true`）的插件包在 1.2.0 规划中**禁止进入线上目录**，仅允许本地安装并在启用时弹出高风险提示。

## 2. 权限档位与工具审批

桌面端界面（`src/renderer/react/features/chat/components/PermissionControl.tsx` 的 `PERMISSION_OPTIONS`）向用户提供三档权限选项，插件工具复用宿主的权限判定（`src/main/platform/permission/permission-policy.ts` 的 `policyFor`）：

| 权限档位 | 界面含义 | `fs-read` | `fs-write` | `shell` | `network` | `input-control` | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read-only` | 只读 | 放行 | 拒绝 | 当前实现放行；**1.2.0 规划插件改为询问** | 放行 | 拒绝 | 1.2.0 规格指出内置命令有命令沙箱兜底，而插件不处于内置命令沙箱中，因此插件声明 `shell` 时只读档位将收紧为询问 |
| `per-action` | 请求审批 | 询问 | 询问 | 询问 | 询问 | 询问 | 每次调用前弹出审批确认 |
| `full` | 完全访问 | 放行 | 放行 | 放行 | 放行 | 放行 | 直接执行对应风险操作 |

需要特别注意当前代码与 1.2.0 规划的差异：

1. **旧枚举残留（当前源码）**：`src/main/platform/permission/permission-policy.ts` 的 `AgentFileAccessLevel` 仍保留 `"project-read-only"` 与 `"scoped"`（设置界面已不再提供，仅在 1.2.0 规格中计划一并删除）。
2. **工具风险声明 `risk`**：
   - 在当前 SDK `0.2.1`（`plugin-sdk/src/api.ts`）中，`PluginTool.risk` 为可选字段，`PluginToolRisk` 包含 `"safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control"`；若声明 `"safe"`，`policyFor` 会直接放行。
   - 依据 [2026-11-12-plugin-sdk-1-2-0.md](../superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md) §4 与 §7.3，1.2.0 将要求每个插件工具**必须**声明至少一项真实风险，**禁止插件使用 `safe`**（因为宿主无法核实第三方工具确无副作用），并在审批卡片标明由插件声明。作者在编写新插件时即应如实声明 `fs-read`、`fs-write`、`shell`、`network` 或 `input-control`，不要依赖 `safe` 绕过审批。
3. **渠道与模式边界**：
   - `PluginTool.modes` 可限制工具仅在 `"code"` 或 `"work"` 中暴露。
   - 根据 [disclaimer.zh-CN.md](../disclaimer.zh-CN.md) ④，当前渠道策略仅在 Chat / Work 间切换（不包含 Code）；在 1.2.0 规格 §7.4 中进一步规划了“渠道默认 Chat，开启 Work 仅放行 `fs-read`，外部平台不接受审批”，但以当前主分支代码为准，目前渠道 Work 路径仍待独立收紧（详见已知问题记录）。
4. **不可信内容隔离意识**：插件通过提示词 Provider 返回的文本、接入的外部渠道消息、以及工具执行输出最终都会进入模型上下文；请勿将外部输入当成系统指令拼接，避免提示词注入风险。
5. **定时任务授权**：插件通过 `ctx.deps.scheduler` 创建的定时任务默认停用（`enabled: false`），不能请求“全部工具”模式，必须显式提供 `allowedToolIds`；且只要改动执行规格（`schedule`、`prompt`、`mode`、`allowedToolIds`），宿主会撤销既有用户授权并将任务恢复为停用，等待用户再次确认（`plugin-sdk/src/api.ts`、`src/plugins/api.ts`）。

## 3. 数据与密钥存储规范

宿主为每个插件提供独立的持久化目录与加密密钥存储，**升级、版本切换与卸载默认均保留数据与密钥**：

| 存储机制 | 适用内容 | 实际落盘位置（相对 `userData`） | 格式与保护边界 |
| --- | --- | --- | --- |
| `ctx.storage`（`src/plugins/storage.ts`） | 普通插件配置、状态缓存、非敏感数据 | `plugin-data/<pluginId>/<key>.json` | 仅支持可 JSON 序列化的数据（`JSON.stringify`/`JSON.parse`），以 `.tmp` + 重命名原子落盘；`key` 须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`。**磁盘明文存储，禁止写入 API Key、Token 等凭据** |
| `ctx.deps.secrets`（`src/main/features/plugins/host/secrets-service.ts`） | API Key、Token 等敏感凭据 | `plugin-data/<pluginId>/secrets/<SHA256(key)>.enc` | 需在 `manifest.json` 的 `deps` 中声明 `"secrets"`；值必须为字符串，经 Electron `safeStorage`（Windows 下为 DPAPI）加密保存；若 `safeStorage.isEncryptionAvailable()` 为 `false`，宿主直接返回 `E_STORAGE_UNAVAILABLE` 并拒绝降级明文落盘 |
| 版本目录与安装状态（`plugin-sdk/LIFECYCLE.md`） | 宿主管理的插件代码与安装状态 | `plugin-packages/<SHA256(pluginId)>/<UUID>/`、`plugin-install-state/<id>.json`、`plugin-install-metadata/` | 作者与开发者不应直接修改宿主管理的版本目录（文件树摘要不一致会被拒绝加载）；迁移至 v2 安装状态的配置目录不可直接交给旧版应用读取 |

关于目录根路径与生命周期细节：

- 通过 `ctx.storage.rootDir()` 可取得 `<userData>/plugin-data/<pluginId>`，如需存放大文件应置于该目录下，但不得写入密钥明文。
- 插件停止或卸载时，宿主按 `beginStop()` → `unregister()` → `ctx.dispose()` 顺序收尾（`src/plugins/manager.ts`、`plugin-sdk/LIFECYCLE.md`）。**注意不要在 `unregister()` 中先清空模块状态变量、随后又在 `ctx.onDispose()` 中把空状态写回 `ctx.storage`**，否则会丢失缓存数据（`examples/README.md` 已记录同类反模式）。
- 当前 1.1.x 的用户数据目录由 `src/main/base/identity/data-directory.ts` 解析；1.2.0 计划切换至 `%APPDATA%\Firefly-1.2.0`，且 1.2.0 规格 §8 明确不迁移 1.1.x 的 `plugins/`、`plugin-data/` 和 0.x 插件（以实际切换实现为准）。

## 4. 发布与验收流程

插件与 SDK 的发布流程已有专门文档维护，本文仅给出入口索引，具体规则与命令以原文档为准：

- **发布插件到官方插件目录与随应用离线目录**：见 [plugin-catalog-publishing.md](../plugin-catalog-publishing.md)
  - 线上目录位于独立仓库 `Firefly-0423/firefly-plugins`（PR 提交源码校验、合并后由维护者运行 Release 工作流并固定 ZIP SHA-256）。
  - 随应用离线包由 `scripts/plugin-marketplace/build.mjs` 从 `examples/<id>/` 构建至 `resources/plugin-marketplace/`，并与线上使用同一套确定性 ZIP 打包规则。
  - 安全边界实现与测试当前分别位于 `src/main/features/plugins/host/plugin-marketplace.ts` 与 `src/main/knowledge/skills/external-boundary.test.ts`（`plugin-catalog-publishing.md` 中仍沿用主进程七层分层前的旧文件名提示）。
- **发布 `@firefly_wu/plugin-sdk` 到 npm**：见 [plugin-sdk-publishing.md](../plugin-sdk-publishing.md)
  - 通过 `.github/workflows/plugin-sdk-publish.yml` 使用 npm OIDC Trusted Publishing 发布，版本标签格式为 `plugin-sdk-v<version>`，发布前执行 `npm run check:plugin-sdk` 与 `npm run test:plugin-examples`。
- **宿主生命周期与真实 Electron 验收参考**：见 [plugin-sdk/LIFECYCLE.md](../../plugin-sdk/LIFECYCLE.md) 与 [plugin-lifecycle-validation.md](../plugin-lifecycle-validation.md)
  - 涉及更新重启切换、失败恢复、版本目录清理与面板边界校验时，可对照其中的测试矩阵与验证方式执行验证。
