# Firefly 1.2.0 插件作者须知

本文说明编写与分发 Firefly 1.2.0 插件时的**信任边界、权限档位、敏感能力确认、数据与密钥存储**及**发布流程**。清单字段与 `ctx.*` 接口逐项参考见 [plugin-dev-guide.md](./plugin-dev-guide.md)。

## 1. 信任模型：进程隔离不是沙箱，启用即信任代码

- **独立进程运行（`utilityProcess`）**：1.2.0 已启用插件运行在独立的 Electron `utilityProcess` 中（`src/plugins/v2/host/index.ts`），通过 `MessageChannelMain` 二进制 RPC 与宿主通信。子进程使用精简环境变量（仅保留系统加载目录与 `TEMP`/`TMP`，不继承宿主的 `NODE_OPTIONS`、代理设置或系统凭据）。
- **进程隔离 ≠ 安全沙箱**：隔离保护的是 Firefly 宿主进程稳定性与宿主内部数据；插件在其自身进程中仍具备完整 Node.js 文件系统与网络访问权限。因此，**启用一个插件即意味着信任该插件的代码**（首次安装默认停用，启用确认框会显式提示这一点）。
- **与 0.x 不兼容**：1.2.0 不支持 0.x 插件（`apiVersion: 1`、`manifest.json`、`ctx.deps.*`、`register`/`unregister`），也不读取或迁移 1.1.x 的 `plugins/`、`plugin-data/`（Windows 默认数据目录为 `%APPDATA%\Firefly-1.2.0`）。
- **原生模块限制（`native: true`）**：包内含 `.node` 或 `.dll` 时必须在 `firefly.plugin.json` 中声明 `"native": true`（否则 `firefly-plugin validate` / 宿主校验报 `native_binary_undeclared`）。含原生模块的插件**禁止进入线上官方目录**，仅允许本地 `.ffplugin` 安装，并在启用时弹出高风险提示。

## 2. 工具风险与三档权限策略

桌面端提供三档权限策略（`src/main/platform/permission/permission-policy.ts`，旧值 `"project-read-only"` 与 `"scoped"` 已移除）：

| 权限档位 | 界面含义 | `fs-read` | `fs-write` | `shell` | `network` | `input-control` | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read-only` | 只读 | 放行 | 拒绝 | **询问** | 放行 | 拒绝 | 插件不在内置命令沙箱中，因此插件声明 `shell` 时在只读档位改为询问 |
| `per-action` | 请求审批 | 询问 | 询问 | 询问 | 询问 | 询问 | 每次调用前弹出审批卡片 |
| `full` | 完全访问 | 放行 | 放行 | 放行 | 放行 | 放行 | 直接执行对应风险操作 |

编写工具时必须遵守以下边界：

1. **禁止声明 `"safe"`**：宿主无法核实第三方插件工具是否真正无副作用，因此插件工具的 `risk` 必填且至少包含一项真实风险（`fs-read`、`fs-write`、`shell`、`network`、`input-control`），声明 `"safe"` 会在清单校验阶段被拒绝（`risk_safe_forbidden`）。
2. **仅在 Work / Code 模式挂载**：插件工具只在 `work` / `code` 模式注册给模型，Chat 模式不挂载插件工具。
3. **审批卡片透明展示**：审批卡片会标明来源插件名称，并展示插件可选提供的 `describeApproval(args)` 摘要与目标。
4. **结构化四态结果与不确定效果保护**：工具返回 `succeeded`、`failed`、`unknown`、`not_executed`。当插件声明非纯读风险且发生崩溃、超时或 `unknown` 结果时，宿主将其视为存在不确定副作用并禁止自动重试。
5. **外部渠道（C12，即将提供）**：渠道接入宿主后默认运行在 Chat 模式；在特定会话开启 Work 时将仅放行 `fs-read` 风险工具，且外部聊天平台不接受交互式审批（目前渠道能力仍处于 C12 接入阶段，标为“即将提供”）。

## 3. 能力权限、首次调用确认与限频

清单 `permissions` 数组支持以下 8 项权限（均在启用插件时向用户集中展示，且可在设置页随时撤销，撤销后立即生效并返回 `ERR_PERMISSION`）：

| 权限 | 是否首次调用单独确认 | 附加约束 |
| --- | --- | --- |
| `sessions.read` | **是** | 仅读取当前绑定工作区下的公开对话投影（经宿主脱敏，无工具轨迹与他插件私有记录），单页上限 100 条（默认 50） |
| `workspace.read` | **是** | 仅读取当前宿主绑定的工作区元数据与变更事件 |
| `model.run` | **是** | 复用宿主正常 Run 控制器与审批路径，运行期间展示「插件正在借用模型」与停止按钮；与 `model.generate` 共享限频 |
| `model.generate` | 否 | 与 `model.run` 共享每分钟滑动窗口限频（默认 10 次/分钟，宿主可配置 1–60），超限抛出 `ERR_RATE_LIMITED` |
| `events` | 否 | 仅投递当前插件可观察的脱敏事件，队列上限 100 条（溢出丢弃最旧记录） |
| `schedules` | 否（任务须批准） | `propose` / `update` 立即返回 `pending_approval`；修改执行规格会重新触发审批。无人值守触发时若涉及高风险工具会挂起等待用户批准 |
| `secrets` | 否 | 由主进程加密存储，见下文第 4 节 |
| `ui.windows` | 否 | 仅允许打开在 `manifest.ui.windows` 中静态声明的独立窗口；独立窗口与设置页通过受限桥 `window.fireflyPlugin` 通信，且插件隔离会话默认拒绝摄像头/麦克风/通知等浏览器权限请求 |

关于**首次调用确认**机制（`src/plugins/v2/services/index.ts`）：
- `sessions.read`、`workspace.read`、`model.run` 在首次实际调用时由宿主弹出确认提示（120 秒未应答按取消处理，且不写入持久化确认记录）。
- 确认通过后按授予版本（grant revision）持久化，切换会话或重启应用不再重复弹窗；若权限被撤销后重新授予、插件停用或升级版本，则会重置授予版本并重新要求首次确认。

## 4. 不可信内容与数据/密钥存储

- **不可信外部数据隔离**：插件 `ctx.context` 注入的上下文文本、工具返回值以及（即将提供的）渠道入站消息都视为外部数据；宿主上下文服务对单 Provider 限制 1,500 ms 超时与 16,000 字符上限（总上限 32,000 字符），并用外部数据边界标记包裹后送入模型，插件不得将外部输入伪装为系统指令。
- **插件私有目录（`ctx.dataDir`）**：宿主为每个插件分配独立工作目录 `ctx.dataDir`，用于存放非敏感缓存与配置文件。**严禁将 API Key、Token 等凭据以明文写入 `ctx.dataDir`。**
- **加密凭据存储（`ctx.secrets`）**：须在 `permissions` 声明 `"secrets"`。主进程通过 Electron `safeStorage` 加密保存到独立存储；若当前系统加密不可用（例如 `safeStorage.isEncryptionAvailable()` 为 `false` 或 Linux 降级为 `basic_text`），宿主**直接拒绝并返回 `ERR_UNAVAILABLE`**，绝不降级为明文落盘。

## 5. 发布与验收流程

- **npm 发布 `@firefly_wu/plugin-sdk`**：见 [plugin-sdk-publishing.md](../plugin-sdk-publishing.md)（`.github/workflows/plugin-sdk-publish.yml`，标签格式 `plugin-sdk-v<version>`，发布前执行 `pnpm run check:plugin-sdk` 与 `pnpm run test:plugin-examples`）。
- **插件目录与离线包**：见 [plugin-catalog-publishing.md](../plugin-catalog-publishing.md)（独立仓库 `Firefly-0423/firefly-plugins` 与本地校验规则）。
- **进程生命周期与隔离细节**：见 [plugin-sdk/LIFECYCLE.md](../../plugin-sdk/LIFECYCLE.md)（历史 1.1.x 验收参考见 [plugin-lifecycle-validation.md](../plugin-lifecycle-validation.md)）。
