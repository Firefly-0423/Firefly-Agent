# 设备 Connector 本地模拟

这是显式调用的 test/smoke 工具模块，不接入应用正常启动、GUI 或真实设备。所有状态、预览、命令与回执均标记 `simulation:true`。它复用已有 MCP adapter、SDK 和 ToolRegistry，不写 `mcp-servers.json`，不增加通用安装器、厂商 SDK、账户授权或真实凭据。

## 固定设备与动作

| fixture | 初始状态 | 允许动作 |
| --- | --- | --- |
| `light` | 关闭，亮度 50，revision 0 | 布尔开关；整数亮度 0–100 |
| `ac` | 关闭，cool，目标 24°C，当前室温 26°C | 开关；cool/heat/fan；目标 16–30°C、步长 0.5°C |
| `curtain` | position 0，revision 0 | 整数位置 0–100；本 fixture 明确 0=关、100=开 |

目标温度变化不表示室温立即改变。窗帘方向只属于这个 fixture，不外推到厂商设备。未知设备、动作、附加字段、字符串数字、非有限数值和越界值均拒绝。

## 宿主授权与 MCP

可信模拟 harness 创建 `DeviceSimulation(context)`，其 `StorageContext` 必须来自具有 isolationRoot 的 test/smoke profile；production/development 均拒绝。`openSession` 只在宿主 API 中接收 synthetic owner、设备读取清单和逐设备动作清单，默认没有任何授权。返回 session 是进程内对象身份，不能通过 JSON、同名 owner 或 `allow_all` 伪造。

`openFixtureMcp(simulation, session)` 创建一个仅绑定 `127.0.0.1` 的临时 SSE listener，并通过既有 `connectMcpServer` 发现四个固定工具：`read`、`preview`、`execute`、`receipt`。SSE 是当前宿主已支持的兼容路径；已安装 SDK 1.31.0 将该 server API 标为 deprecated，本批没有扩展通用传输支持。URL 由模块自己生成，不接收任意 URL、命令、环境变量或认证配置。

读取与预览不改 fixture 或命令日志。预览绑定 session、owner、epoch、设备、规范动作、原状态/revision、摘要和 30 秒期限。确认只能由可信 harness 调用 `confirm(session, previewId)`，不能由 MCP、模型参数或 annotations 触发。示例在已初始化的隔离 Main/tool 测试环境中使用：

```ts
const sim = new DeviceSimulation(context);
const session = sim.openSession({
  owner: "demo-owner", read: ["light"], actions: { light: ["power"] },
});
const connection = await openFixtureMcp(sim, session);
try {
  const preview = sim.preview(session, "light", { type: "power", on: true });
  // 仅演示 harness 的明确确认；不是 GUI 用户确认已实现的声明。
  const approved = sim.confirm(session, preview.id);
  const result = await sim.dispatch(session, approved.id, connection.port);
} finally {
  await connection.close();
  sim.close();
}
```

`dispatch` 在发送前再次验证 scope、精确 session、epoch、期限和 revision，并先持久化 `dispatching`。MCP execute 只收到非秘密 operationId；fixture handler 独立检查已确认的不可变意图与发送标记，直接调用或绕过通用工具审批也不能创建授权。`receipt` 只查询；grant、confirm、cancel、completeFixture 均不是 MCP 工具。

## 状态、持久化与恢复

| 状态 | 意义 |
| --- | --- |
| approved | 已确认但未发送；not_applied |
| dispatching | 已记录发送意图；结果未知 |
| accepted | provider 接受且尚未证明应用；unknown |
| applied | 回执和 owned fixture 持久完成记录一致；只证明模拟应用 |
| rejected / cancelled | 本 fixture 拒绝或宿主取消未发送命令；not_applied |
| unknown | 超时、失联、发送后取消、错误回执或所有权丢失；不自动重发 |

日志位于 profile 的 `userData/device-simulation/journal.json`，通过现有 `AtomicJsonStore` 写入。应用 fixture 效果与 provider 回执在同一次原子写中保存。Main 验证返回回执的 provider、owner、epoch、operationId、意图摘要、设备、动作、阶段和结果状态，并要求最终回执符合 owned fixture 的持久记录；这不是远端厂商加密证明。

默认即时 fixture 返回 applied；测试 harness 可显式选择 deferred 设备。deferred 命令先 accepted，只有宿主的 `completeFixture` 模拟完成后，Main 再通过 MCP receipt 查询验证。重复 operationId 只返回已有回执，不重复改变设备。状态恰好等于目标值不能证明某个命令曾执行。

关闭后重建控制器会保留未决记录，将残留 dispatching 转为 unknown。旧 epoch 的批准不能再执行；`reconcile` 只查回执，不发送新命令、不自动回滚。已验证的 applied/rejected/cancelled 终态不会被迟到的 accepted 回执降级。accepted 后撤权或取消无法证明原命令未发生，不能改成 not_applied。

`assertReady(session)` 是不写入的统一检查：验证当前路径、lease、文件大小和既有 JSON/schema，不用磁盘内容覆盖进程内状态。创建 fixture listener/连接、发出 reconcile 查询和处理 fixture MCP 请求前均执行它。运行中日志损坏或 lease 丢失会先拒绝，保留损坏字节或其他 owner 的状态。

## 限制与验证入口

最多 32 个内存预览、128 个日志命令，日志最多 1 MiB。仅可按最旧顺序淘汰已验证终态；未决记录不为新命令让路。固定目录/文件检查规范路径、普通文件、单硬链接和大小；损坏的既有日志不会被覆盖。profile 内排他 lease 阻止并发 owner，HTTP 拒绝非预期 Host、Origin、会话、路由和超过 16 KiB 的 JSON 请求。

正常 close/重建已测试。进程异常退出会保留 lease 并拒绝重新接管；本批不自动删除陈旧 lease，也不实现离线恢复工具。不得声称已验证 OS 进程崩溃恢复、多进程 exactly-once、真实 GUI 确认、真实账户/设备、厂商遥测或网络故障下的真实硬件行为。

在已有隔离依赖环境运行 `npm test -- device-simulation`。实际 SDK/HTTP/adapter/registry 集成测试位于 `src/main/device-simulation/mcp-fixture.integration.test.ts`；模块替身限于 Electron/RAG 环境依赖，异常用例另有受控 provider 故障注入，SDK/HTTP/adapter/registry 保持真实。测试使用独立临时 profile；本任务同时设置空 Electron runtime override，以阻止依赖模块隐式下载或启动 Electron。无需安装候选插件、调用付费模型或输入凭据。

清理按两层归属执行：adapter 记录自己注册的 ToolDefinition 对象，仅在 registry 仍持有同一对象时注销；fixture 另以 Main 内存 owner 对象绑定原连接。宿主后来替换同 namespace 的工具定义会被保留，但不阻止原 client/transport 释放；旧 fixture 也不能关闭同 server ID 的后来连接。owner 不进入配置、MCP 参数或领域授权，既有不传 owner 的 Main 接口保持兼容。

成功关闭保持幂等；若 client 与 fallback transport 的释放都失败，会明确报错，并允许调用者再次关闭来重试归属清理。重试仍受原 owner 限制，只执行资源释放。

首次打开且主日志、备份都不存在时仍允许初始化。一旦本实例观察到日志/备份或成功写入，主日志缺失即拒绝读写；仅剩备份时也拒绝把它当全新 profile。不会用内存 fallback 重新创建已丢失的日志；回执查询和 listener 创建保持前置阻断。

真实 Connector 的后续设计仍需明确厂商协议、设备能力/单位/方向映射、凭据保管、GUI 精确授权和厂商回执/遥测契约，须另行授权。
