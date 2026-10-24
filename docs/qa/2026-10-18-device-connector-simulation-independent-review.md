# Device Connector 模拟批次独立审查

日期：2026-10-18。结论：**Request changes：修复两项 Important 后再完成最终验证。**

| 分级 | 数量 |
| --- | ---: |
| Critical | 0 |
| Important | 2 |
| Minor | 1 |

固定 Base：`eac3e67c1d7d1f2b7a842a31c4f3d3420ef79f77`。固定 Head：`1317bf37e64e5a7184ec42bfce20ced3fe4763ad`。审查包去掉说明前言后的 diff 与该提交区间一致；开始及收尾检查时 checkout 均干净、HEAD 未变。范围为 11 个新增文件、1325 行，其中运行时代码 4 个文件、533 行。未重新开启外部市场批次审查。

已读 AGENTS.md、spec、plan、ledger 的 Ruling、用户文档、全部新增源码与测试，以及 AtomicJsonStore、runtime-profile、StorageContext、相关 adapter/registry 和已安装 SDK 1.31.0 的 SSE 实现。合并使用 code-review-and-quality、differential-review、security-and-hardening；按仓库要求核对 context-engineering、现有约束、source-driven-development 与 verification-before-completion。发现问题后遵循 systematic-debugging，先复现再提出最小修复路线。本席未派子 agent、未修改 checkout/index/HEAD/分支/依赖，唯一持久输出为本报告。

## Strengths

- 边界明确。生产源码中 `new DeviceSimulation` 调用点为 0，`openFixtureMcp` 的调用点为 0；`new SimulationJournal` 只有 controller 内 1 处。没有应用启动、通用 manager、权限策略、adapter 或依赖文件改动。新问题的影响范围是显式启用的本地模拟 harness。
- 动作校验采用封闭形状和固定设备/动作表，无字符串转换；AC 目标温度与室温分开，窗帘方向明确。快照、预览、结果及授权配置均复制，模型不能通过改返回 DTO 改写真实意图。
- opaque session 使用对象身份，精确 approval 还绑定原 session；owner 同名本身不能继承执行确认。confirm 不暴露给 MCP，execute 只接受 operationId，通用 `allow_all` 不能建立 domain authorization。
- 新发送先同步持久化 dispatching，provider 处理又独立检查精确 approval、scope、epoch、期限与 revision。effect 与 providerReceipt 同次写入；重复 ID 读取已有 providerReceipt。未知结果没有自动重发、逆动作或新 ID 重放。
- 回执逐字段绑定 owner/provider/epoch/operation/digest/device/action/state；final RPC 结果须与 owned fixture 持久 providerReceipt 一致。错误回执不会把尚未完成的 accepted 升为 applied。该本地交叉校验没有被宣传为厂商加密证明。
- Journal 新写入前检查 profile、规范路径、单链接普通文件、大小、lease 与既有 JSON/schema；AtomicJsonStore 保留旧目标至原子替换成功。异常退出 lease fail-closed 的限制写得明确。
- 已关闭 controller 的迟到响应不再保存；重建只将 dispatching 变为 unknown，旧 epoch approval 不能执行。已发送后的取消保持 unknown。现有相关测试分别覆盖这些行为。
- 测试不是只用 callback 假装 MCP 成功：归档包含实际 SDK/HTTP/adapter/registry 路径，环境替身与 provider 故障注入范围明确。状态与错误码清晰，四个运行时文件规模有界，无需本批重构通用模块。

## Issues

### I1 — Important：迟到 accepted 覆盖已验证的终态

**位置：** `src/main/device-simulation/controller.ts:131`；入口 `controller.ts:119`、`controller.ts:123`。相关接受规则在 `src/main/device-simulation/contracts.ts:117`。代码由 `5801d85` 引入。

**触发条件：** deferred execute 已在 provider 持久化 accepted，但 transport/注入 port 延迟返回这份 accepted；期间可信 harness 完成 fixture，另一次 reconcile 读取并验证 applied（或 rejected）；随后原 execute 回执到达。无需伪造 receipt 或撤权，也无需真实设备。

**根因：** reconcile 在 await 后检查最新 status 是否 terminal（`controller.ts:150`），dispatch 没有相同保护。`acceptReceipt` 无条件将 `verifiedReceipt`、`status` 赋为本次 receipt 的阶段。校验器有意容许“provider 已完成之后才到达的旧 accepted”，因此这种旧 accepted 通过校验后能够覆盖已经确认的终态。

**实际影响：** 同一模拟命令已经向用户报告 applied，随后持久日志却回到 accepted，`pending()` 再次列出该命令，`effectState` 从 applied 倒退为 unknown；已确认的终态记录失去可淘汰资格。没有重复 fixture effect，但 durable 状态与用户已见过的完成结论不再单调一致。它是正常异步组合中的状态机错误，因此定 Important。

**独立复现：已复现。** 使用未改源码、真实 controller/AtomicJsonStore 与独立临时 profile，只有 McpDevicePort 注入可控的迟到应答；本项没有声称在实际 SSE 流上复现消息重排。

```ts
// op 已通过正常 preview + confirm；light 显式配置为 deferred。
let release!: () => void;
const waiting = sim.dispatch(session, op.id, {
  ...port,
  execute: id => {
    const accepted = sim.handleMcp(session, "execute", { operationId: id });
    return new Promise(resolve => { release = () => resolve(accepted); });
  },
});
sim.completeFixture(op.id);
const completed = await sim.reconcile(session, op.id, port);
release();
const late = await waiting;
```

实际输出：

```json
{"beforeLate":"applied","afterLate":"accepted","persisted":"accepted","provider":"applied","verified":"accepted","fixture":{"revision":1,"power":true}}
```

**最小路线：** 在共同的 receipt 状态转换处保护已验证 terminal，不允许后续 accepted 将其降级；保证 dispatch、reconcile 共享这一不变量。无需删除允许迟到 accepted 的保守校验规则。新增上述交错的回归，断言最终 view、持久 status、verifiedReceipt 与 pending 均保持终态；也覆盖 completion 最终 rejected 的交错。

**覆盖差距：** 当前测试有同 ID 同时 dispatch，以及关闭后迟到 ack；没有 execute ack 与完成后的 reconcile 竞争。现有测试因而无法发现本例。

### I2 — Important：日志/lease 失效后仍先调用 receipt port

**位置：** `src/main/device-simulation/controller.ts:147`，关联 `controller.ts:50`、`controller.ts:64`；相同缺口涉及 `src/main/device-simulation/mcp-fixture.ts:40` 的 listener/连接前检查。journal 实际校验位于 `src/main/device-simulation/journal.ts:48`、`journal.ts:58`。入口由 `5801d85`、wrapper 由 `1317bf3` 引入。

**触发条件：** controller 已打开且有 unknown/accepted/dispatching 命令；随后 journal 损坏、被换成不合规文件，或 lease 已不再属于该 controller；再调用 reconcile。openFixtureMcp 在已打开 controller 的 journal/lease 失效后同样只调用内存 pending 检查，便可开始 listener/SDK 连接。

**根因：** session/ownedOperation 仅检查内存的 active grant 与 operation。reconcile 在调用 `port.receipt` 前不经过 journal 的 guard/read；只有之后要保存结果或 unknown 时才触发路径、lease、大小、JSON 检查。最终返回 unknown 能阻止旧 owner 写入，但无法撤销已经发出的查询。wrapper 的 `pending(session)` 也不是持久 ownership/health 检查。

**实际影响：** 已失去 profile ownership 或持有损坏持久状态的实例仍能发起一次 MCP 验证请求/建立新的 fixture 协议连接。当前受限模块的请求是本地只读请求，没有据此发现 fixture effect 或新 owner 日志被覆盖；但本批承诺的“任何 fixture effect 或外部请求前 fail-closed”并未覆盖整个协议回路。该模拟无法证明预期的失效所有权隔离，定 Important。

**独立复现：已复现 corruption 与 lease 两种情况。** 使用未改源码、独立临时 profile 和计数的 receipt port，先令合法 dispatch 返回 unknown，再分别改本复现自有 journal/lease，调用 reconcile。实际输出：

```json
{"case":"corrupt-before-reconcile","receiptCalls":1,"result":"unknown","journalBytes":"not-json"}
{"case":"lost-owner-before-reconcile","receiptCalls":1,"result":"unknown"}
```

这些结果证明 port 已被实际调用；未把它们冒充真实 HTTP 请求观测。换成既有 MCP port 时，该相同调用点会进入实际 adapter 发送。symlink/hardlink/oversized 变体和 openFixtureMcp 的缺口来自同一静态控制流，本席未逐个运行这些变体。

**最小路线：** 提供不写入的统一 journal health/ownership 校验，同时执行路径、lease、字节上限和既有 JSON/schema 检查；在 reconcile 调用 port 之前，以及 wrapper 创建 listener/连接之前执行。不要仅检查 lease/文件 stat 而漏掉 corrupt JSON，也不要把 disk reload 直接覆盖当前内存状态。保持 read/preview 不产生 fixture/journal 写入。新增运行中损坏/更换文件与 ownership 丢失的测试，断言 receipt/execute 调用数为 0、没有 listener/registry 新增，并保留损坏字节或新 owner 状态。

**覆盖差距：** journal 测试验证打开与写入边界；controller 有发送前保存失败测试。缺少“打开成功后失效、在只读请求之前”的测试。新发送的 dispatch 保存路径本身已有保护，本项不声称该路径绕过了持久化。

### M1 — Minor：registry 部分替换时 close 成功返回但遗留 adapter 资源

**位置：** `src/main/device-simulation/mcp-fixture.ts:81`、`mcp-fixture.ts:82`、`mcp-fixture.ts:88`。由 `1317bf3` 引入。

**触发条件：** 可信宿主主动用另一个 ToolDefinition 覆盖该连接随机 namespace 下的一个 registry ID，然后关闭 fixture。它不是模型 MCP 参数能够触发的操作。

**根因：** `stillOwned` 是“全部 tool 定义都相同”的整体判断；有一个定义变化就完全跳过 disconnectMcpServer。后续关闭 server SDK/HTTP 不能关闭 adapter 所持有的 SSE client，代码仍将 cleanup 当作成功。`closePromise` 缓存该成功结果，之后 close 也不会再次尝试释放。

**实际影响：** 模拟 listener 已关，但 adapter 仍报告 connected，旧工具残留，SSE client 资源仍存活并可能重连。需要可信宿主覆盖随机模拟 namespace，影响受限于该模拟 harness 的清理与 registry 污染，定 Minor。

**独立复现：已复现。** 独立 Node 进程，真实 SDK 1.31.0、HTTP、adapter、registry；只替换环境 RAG/Electron 模块，未替换协议。注册连接后覆盖 `serverId + "-read"`，调用 connection.close。实际结果：

```json
{"case":"registry-replacement-close","connected":true,"toolCount":4,"replacementPreserved":true,"oldOtherToolsStillRegistered":3}
```

复现结束时已在该独立进程内显式 disconnect 并清理自有临时 profile，没有留下服务或更改用户配置。

**最小路线：** 不要在无法安全释放 adapter 时报告 cleanup 成功；至少使该所有权冲突成为明确的关闭失败，并保留宿主消除冲突后的清理重试能力。若要彻底释放，应将工具条目身份与连接资源身份分开处理，按条目保护 replacement。无需为了这个低频条件扩展真实 Connector 或重写通用 adapter；本轮也可明确记账延期。

**覆盖差距：** cleanup 测试只有另一个无关 ID 的 sentinel；没有覆盖同 namespace 下定义变化的分支。

## Declined to judge

- **接受后撤权/过期的 deferred completion：** 接受之前的 dispatch 与 provider handler 均重新校验当前 scope；已 accepted 命令被建模为不能用本地取消证明未发生。completeFixture 是可信 harness 对已接受 provider 结果的模拟，且重建后仍允许完成。没有据此要求撤权必然撤销已接受命令；这会与已记录的不确定性模型冲突。
- **异常退出自动接管、多进程 exactly-once、真正 OS crash recovery：** ledger 明确选择 stale lease fail-closed，无自动删除；本席没有要求增加 recovery 工具或跨进程 CAS。也未把普通路径检查解释为抵御任意同用户恶意进程持续替换目录的 OS 隔离保证。
- **本地 journal 的密码学防篡改：** 当前保证为封闭形状、摘要自洽、文件边界与 owned provider 记录交叉校验；不是对能重写整个合法 journal 的本机攻击者的独立 attestation。未扩大为签名日志需求。I2 只涉及已承诺的失效文件/lease 在请求前被检测。
- **SSE deprecation 与 SDK 的内部网络行为：** 已核对安装的 1.31.0 实现；现有宿主已支持该兼容 transport，spec/用户文档明确限制用途。未要求本批迁移通用 transport，也未根据当前 SDK 细节推定未来版本行为。
- **真实厂商账户、设备遥测、GUI 用户确认、凭据存储、真实硬件延迟：** 不属于本批授权与实现；本席没有将缺少这些能力列为缺陷。
- **wall-clock 回退、任意同进程对象/导出常量篡改、无限可信宿主 session 创建：** 本批时间源与宿主 API 本身属于可信 harness；未发现经 MCP JSON 参数即可获得这些能力的路径。没有为这些场景增加模型权限或限额需求。
- **更广的性能预算、依赖升级和 npm audit：** 本批无依赖变动、无发布；预览/操作/字节上限已固定。未重跑外部依赖审计或安装新工具。
- **本轮 mutation test：** 审查授权明确禁止修改产品源码，因此没有执行技能建议的源码反转；改用未改源码的独立临时 profile 合成复现。不能据此声称 mutation coverage 达标。

## Assessment

Review Focus 核查结果：

| Focus | 判断与证据 |
| --- | --- |
| 1. 直接注册 MCP execute / allow_all 仍需精确持久授权 | 通过静态核查与既有集成归档；confirm 不暴露，handler 检查 dispatching、原 session approval、scope、epoch、期限、revision。 |
| 2. 发送后取消/关闭迟到响应不误报 not_applied、不覆盖新 owner | 这些指定路径的静态逻辑与既有测试成立；另有未关闭同实例的终态倒退 I1，须修复。 |
| 3. 错 owner/epoch/device/intent 回执保持 unknown、无重发 | 静态与既有逐字段对抗测试覆盖；final 回执还受 durable providerReceipt 约束。 |
| 4. 不合规 journal/并发 owner 在 effect 或请求前 fail-closed | 新 effect/dispatch 保存边界成立；只读网络请求前的 runtime health 校验缺失，I2 已复现。 |
| 5. AC setpoint、accepted 不冒充室温变化或已应用 | fixture 数据与 receipt/view 映射成立；I1 会把已验证应用降回未知，没有发现反向伪报 applied。 |

验证证据分层：

- **已有实际执行归档，本席重新读取并核对：** `audit/device-simulation/test-reports/2026-10-18T05-21-02-016Z-98cd345b-e817-4d89-a470-d34dac833553/report.json` 为 completed，398 passed，27 文件，0 skipped，0 unhandled errors，内含 77 项 device-simulation 用例。开始/结束 revision 记录一致；当时未提交 tracked diff 的 SHA256 与 `5801d85..1317bf3` 两个 controller 文件的实际 diff 一致，3 个当时 untracked 新文件的 SHA256 与固定 Head 工作树一致。没有为审查重跑这些已通过命令。
- **Main 类型检查与存储边界：** ledger/current-progress 记录最终 Main `tsc --noEmit` exit 0；本席未重跑，最终类型日志为空。实际存储边界日志为 `PASS: 88 allowlisted accesses in 46 files`。不将空日志本身当作独立 exit-code 证明。
- **本席新执行：** 未改源码，通过已安装 TypeScript 内存转译加载实际模块；Node v24.19.0。第一个复现命令验证 I1 与 I2 的两个变体，exit 0；第二个复现命令用真实 SDK/HTTP/adapter/registry 验证 M1，exit 0。全部临时目录在删除前检查位于任务根且 basename 为本席前缀；清理已完成。
- **环境限制及处置：** 初次 sandbox 合成加载在自有临时 profile 的 `fs.realpathSync.native(.../isolated)` 被 Windows 返回 EPERM，未到达 fixture 构造/执行。相同 API 在 sandbox 的任务目录探针也为 EPERM。随后对明确范围的独立 Node/临时 fixture 命令使用 require_escalated，自动审查允许，两次复现均完成；没有自动审批拒绝、待批或结果不明的剩余动作。
- **仍未执行：** 设备改动的最终全量测试。本席不将此前整合批次全量或上述 398 项组合回归冒充本批最终全量，也没有独立运行 GUI/真实设备/厂商协议/安装下载。

历史与 blast radius：四个提交均为本批新模块/文档，无基线安全检查被删除；对 controller 敏感行及基线 adapter 的 ownership 检查已做 blame。高风险调用链仅为显式 harness → controller/journal、显式 wrapper → 既有 adapter/registry → owned loopback provider；没有生产启动调用方。`validateReceipt` 有 2 个非测试调用点，分别在 controller 与 journal schema 校验中；`SimulationJournal` 有 1 个构造调用点。没有将测试条数当作语句覆盖率；本席未计算覆盖率百分比。

建议本轮先修 I1、I2，采用各自缺失交错/失效前置条件的 RED→GREEN 回归，再运行受影响组合验证与计划要求的一次最终全量。M1 可以在本轮处理或明确延期。修复前本批不宜宣称全部验收完成；就当前有界模拟范围，除上述问题外未发现 Critical。对三个具体复现与其根因置信度高，其余判断限于上述静态范围和已核对的执行归档，不承诺真实 Connector 能力。
