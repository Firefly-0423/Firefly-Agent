# Firefly 1.2.0 插件运行生命周期与隔离说明

本文说明 Firefly 1.2.0 插件宿主（`src/plugins/v2/host`）如何管理已安装插件的进程生命周期、状态迁移、超时熔断与隔离边界。插件开发接口见 [README.md](./README.md) 与 [插件开发指南](../docs/plugins/plugin-dev-guide.md)。

> **与 0.x / 1.1.x 的差异**：早期的 `apiVersion: 1`、`register/unregister`、主进程直跑 Node 代码与 `plugins/` + `plugin-install-state/` 机制已在 1.2.0 中废弃；1.2.0 不读取、不迁移 1.1.x 的 `plugins/`、`plugin-data/` 与 0.x 插件（历史 1.1.x 验收记录见 [docs/plugin-lifecycle-validation.md](../docs/plugin-lifecycle-validation.md)）。

## 进程隔离与启动环境

- 已启用插件运行在独立的 Electron `utilityProcess` 中，宿主通过 `MessageChannelMain` 建立 `MessagePort` 二进制帧 RPC 通道（`src/shared/plugin-rpc.ts`）。
- 子进程启动使用精简环境变量（`cleanPluginEnvironment`）：仅保留系统加载所需的 `SystemRoot`/`PATH` 与可写临时目录 `TEMP`/`TMP`，**不继承宿主的 `NODE_OPTIONS`、代理变量、应用设置或系统凭据**。
- **进程隔离不是安全沙箱**：插件进程仍具备 Node.js 文件系统与网络访问能力；隔离保护的是宿主稳定性与宿主私有数据。因此安装后默认停用，启用须由用户确认可信。

## 状态机与转换

宿主为每个插件维护以下六种状态（`PluginHostStatus`）：

| 状态 | 含义 |
| --- | --- |
| `disabled` | 停用状态（首次安装默认状态，或用户手动停用 / 正常停止完成） |
| `starting` | 正在拉起 `utilityProcess` 并等待 `activate(ctx)` 完成 |
| `enabled` | 激活成功，正在运行并响应宿主调用 |
| `stopping` | 正在向插件发送 `deactivate(reason)` 并等待资源释放 |
| `restarting` | 意外退出后的退避重启等待期 |
| `disabled-fault` | 启动失败、内存超限或熔断后的故障停用状态，需用户或宿主显式恢复 |

停止原因（`DeactivateReason`）包括：`"disabled"`（用户停用）、`"quit"`（应用退出）、`"upgrade"`（版本升级）、`"fault"`（异常终止）。

## 超时、内存上限与崩溃熔断

- **启动激活超时**：拉起进程并执行 `activate(ctx)` 的总预算为 **10 秒**（`10_000 ms`），超时抛出 `ERR_TIMEOUT` 并转入 `disabled-fault`。
- **优雅停用窗口**：`stop()` 向插件发送 `deactivate(reason)`，最多等待 **5 秒**（`5_000 ms`），随后关闭 RPC 与端口；若进程未主动退出，经 `750 ms` 宽限期后强制终止子进程。
- **内存监控**：宿主每秒（`1_000 ms`）轮询 `app.getAppMetrics()` 检查插件进程工作集大小，默认上限为 **512 MiB**（`memoryLimitMb ?? 512`），超限立即终止并按崩溃处理。
- **自动重启与熔断**：非正常退出时按 `1 秒 → 5 秒 → 30 秒` 退避自动重启；若 **60 秒内累计崩溃达到 3 次**，触发熔断并进入 `disabled-fault`，不再自动拉起。
- **工具调用中断**：若工具执行期间插件进程意外退出，宿主向模型返回 `{ status: "unknown", reason: "Plugin process exited during tool execution" }`，触发不确定副作用保护且禁止自动重试。
- **通知与渠道连接清理**：插件停用、权限撤销、升级或连接清理时，宿主会关闭待确认的桌面通知并移除点击监听（已显示通知最长保留 5 分钟监听后释放资源）；同时先经实时 RPC 发送 `channel.stop` 并断开渠道连接、取消进行中的渠道运行。通知的每分钟 5 次限频窗口按插件 ID 维护，**不因生命周期重启而重置**。

## 数据目录与包校验边界

- 每个插件获得独立的 `ctx.dataDir`（位于 Firefly 1.2.0 独立数据根下，Windows 默认 `%APPDATA%\Firefly-1.2.0`）。
- 敏感凭据通过 `ctx.secrets` 由主进程调用 Electron `safeStorage` 加密存储，系统加密不可用时拒绝降级明文（`ERR_UNAVAILABLE`）。
- 安装包校验拒绝路径穿越、`..`、包内符号链接与 Windows junction；未声明 `native: true` 时禁止携带 `.node` / `.dll` 原生模块。
