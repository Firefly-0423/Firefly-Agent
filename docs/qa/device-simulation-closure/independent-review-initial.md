# 设备模拟有界清理：初轮独立复审

日期：2026-10-18。固定审查结论：**Request changes；0 Critical、1 Important、1 Minor。** I1 已闭合；原 I2 的损坏 JSON/失去 lease 分支已修复，但运行中主日志缺失分支仍未闭合；M1 正常替换清理已闭合。另发现相邻 M2 关闭失败后不能通过原连接重试的 Minor。应先处置 I2，再进行最终一次干净全量。

本报告冻结本轮原始结论。执行器已接收 I2/M2 并开始后续修复；这些未完成的修复不改变本报告对下列固定 Head 的判断。按执行器后续明确指示保存为 `independent-review-initial.md`，最终增量复核另存 `independent-review.md`。既有原始报告和裁定均保留。

## 固定版本与范围

| 项目 | 固定值 |
| --- | --- |
| Repository | `E:/Codex/2026-10-18/task-2/firefly-external-batch1` |
| Base | `1317bf37e64e5a7184ec42bfce20ced3fe4763ad` |
| Head | `09a065127d80c1b7d1fe0c52cb036f8f473c7721` |
| 原 Important 修复 | `0a5fe23e14657be12cac02ee818472c3194e69ac` |
| M1 增量 Base | `1e587d1bad10f98a90a2bf2b8bfb619bf5f5acdd` |
| M1 增量 | 5 文件，106 additions / 27 deletions |
| 总复审差异 | 12 文件，630 additions / 33 deletions；含原报告、QA 和验证档案 |

首次检查时 checkout 干净、HEAD 为固定 Head。执行器收到本轮问题后开始修改工作树，因此后续产品源码读取和真实 SDK 探针改用 `git show 09a0651:<path>` 固定内容；本席没有修改 checkout、index、HEAD、分支、配置或依赖，没有派发 agent。

使用 Senior Code Reviewer 模板、code-review-and-quality、differential-review、security-and-hardening；遵循 AGENTS.md，以 context-engineering 沿用现有 spec/plan/约束，针对疑点先按 systematic-debugging 最小复现。SDK 语义按 source-driven-development 核对本机安装的 1.31.0 实现，没有重做外部市场或 upstream 研究。用户明确要求只读，未进行源码 mutation 测试。

完整检查的变更源码/测试：

- `src/main/device-simulation/controller.ts`、`controller.test.ts`。
- `src/main/device-simulation/mcp-fixture.ts`、`mcp-fixture.integration.test.ts`。
- `src/main/orchestrator/mcp-adapter.ts`、`mcp-adapter-lifecycle.test.ts`。
- 文档差异：`docs/device-connector-simulation.md`、原 spec/plan，以及新增的原独立审查、QA、verification JSON 三项档案。

依赖上下文：`contracts.ts`、`journal.ts` 及相关测试，`atomic-json-store.ts`、`runtime-profile.ts`、`storage-context.ts`、registry 的 register/getById/unregister，manager 的连接/断开调用，abort/cancellation 边界，以及已安装 SDK 的 Protocol.close、SSE client/server 实现。核对原 `audit/device-simulation/independent-review.md` 及实际测试 JSON/log，没有把旧报告当作本轮批准。

仓库超过 200 文件（实际 2898 tracked files），采取差异及一跳依赖的定向审查。非测试调用面：public connect 有 4 个调用点（fixture 1、manager 3），public disconnect 有 7 个（fixture 1、manager 6）；assertReady 有 3 个调用点（reconcile、handleMcp、wrapper）。原 session/approval/receipt 权限和普通 manager 入口没有新增授权路径。

## Strengths 与闭合判断

| 项目 | 结论及依据 |
| --- | --- |
| I1 | **已闭合。** `controller.ts:132` 在共同 acceptReceipt 转换处先保持 applied/rejected/cancelled；reconcile 和 dispatch 的迟到响应均无法将已验证终态回写 accepted。新增 applied/rejected 交错测试同时核对最终 view、日志字节、verifiedReceipt 与 pending。没有新增执行、重复 effect 或自动 replay。 |
| I2 原损坏/lease 分支 | **已修复。** assertReady 先验证 opaque active session，再执行 journal read 的路径/lease/大小/schema 检查，不把返回的磁盘状态赋给内存。reconcile 在 port.receipt 前检查，wrapper 在 http.createServer 前检查，provider 每次 handleMcp 前检查。腐坏 JSON/foreign lease 有零 receipt、零 listener 的回归。主日志缺失例外见下文，I2 整体尚未闭合。 |
| M1 | **已闭合。** adapter 的 ownedTools 保存精确 ToolDefinition 引用，disconnect、remote-close、注册失败均只删除 registry 仍持有相同对象的条目。wrapper 不再用全体工具身份决定是否释放 client，而以私有 adapterOwner 绑定原连接。真实 SDK 集成覆盖替换后关闭、保留替换项、移除其他旧工具、client/transport 各关闭一次、旧 closure 拒绝和 listener 关闭。 |
| 连接身份与队列 | 相同 owner 才能合并显式 owned connect；不同 owner 的同配置调用经原 per-ID 队列后拒绝冲突。旧 owner disconnect 不能关闭后来同 ID 的连接。不传 owner 的既有 Main 调用兼容；它仍是可信宿主 API，owner 不是 domain grant，也未进入 config/MCP 参数。 |
| 旧回调/失败清理 | execute 在 await 前后均核对当前 client；onclose 只忘记仍为相同 client 的 state；forget 的 map 删除还检查 state 身份。工具引用清理可重复，部分注册中断在 register 前记录待清理定义，因此替换项不会被 catch 误删。adapter 双重关闭失败保留 disconnected state 供后续重试；wrapper 的重试缺口单列 M2。 |

撤权在 dispatch/provider handler 及异步响应验证后继续生效。已 accepted 的可信 harness completion 可在本地撤权后完成，仍须后续有效 session 做回执验证；没有把撤权/发送后取消改成 not_applied。日志 effect/providerReceipt 仍在同一原子写入，旧 controller disposal 后的迟到响应不写下一 owner。

改动保持现有分层，没有新 transport、真实设备、账户、GUI、IPC、bootstrap、manager 配置、依赖或权限策略。每次额外健康检查的工作由 1 MiB/128 operations 的既有上限约束；本席未据此声明量化性能或覆盖率指标。

## Issues

### I2（仍未完全闭合）— Important：运行中主日志缺失被当成首次初始化

**位置：** 固定 Head 的 `src/main/device-simulation/controller.ts:69`、`:152`；依赖 `journal.ts:58` 与 `atomic-json-store.ts` 的 `read(fallback)`。assertReady 在 `0a5fe23` 加入；允许 ENOENT fallback 的 journal 基础逻辑源自 `d9f5ce27`，AtomicJsonStore 原语未改。

**触发：** 已合法确认并 dispatch 的 deferred 命令处于 accepted，lease 仍属于本实例；随后主 `journal.json` 被移走。运行中普通文件丢失本应属于既定 durable health 失败，无需构造合法恶意 journal、伪造 session 或更改域权限。

**根因：** `assertReady` 调用 `journal.read(this.state)`；guard 对主日志不存在继续执行，而 AtomicJsonStore.read 把 ENOENT 转为传入 fallback。该初始化规则没有区分“从未持久化”与“本实例已持久化后丢失”。因此健康检查未验证出持久日志已消失，reconcile 继续查询，随后保存又重建日志。

**独立最小复现，已执行 exit 0：** Node v24.19.0，真实 controller/journal/AtomicJsonStore，单独临时 test profile；port 只做计数和调用真实 handleMcp，没有 HTTP 或真实设备。

```ts
const op = sim.confirm(session, sim.preview(session, "light", { type: "power", on: true }).id).id;
await sim.dispatch(session, op, port); // deferred -> accepted
fs.renameSync(journal, journal + ".review-held");
sim.assertReady(session);             // 不应通过，但实际通过
await sim.reconcile(session, op, port);
```

实际输出：

```json
{"node":"v24.19.0","case":"runtime-journal-missing","before":"accepted","ready":"ok","receiptCalls":1,"after":"accepted","journalRecreated":true}
```

**实际影响与分级：** 失去本应可验证的 durable 记录后仍产生一次外部 receipt 查询，并按内存重建日志；共用 checkpoint 也未能阻止新 listener/provider 请求。独立探针仅实际证明 receiptCalls=1 与重建，listener 分支由同一 checkpoint 的静态控制流可达；未冒充实测 HTTP listener。没有证明真实设备 effect 或跨 owner 写入，但这是原 I2 的 fail-closed 约束缺口，定 Important。

**最小建议：** 由 SimulationJournal 区分初次不存在与本实例已观察到/成功写入后消失，后者在 read/write 前拒绝；不要修改通用 AtomicJsonStore 的合法首次 fallback，也不要用磁盘 reload 覆盖 cached domain state。补 journal read/write、controller receipt 零调用、wrapper listener 零创建，保留首次无日志只读启动行为。现有绿色测试只覆盖 invalid bytes/lease，未覆盖 runtime ENOENT。执行器已接受这项结论并开始最小 TDD 修复；本轮固定 Head 仍有该问题。

### M2 — Minor：一次关闭失败使原连接永远复用 rejected closePromise

**位置：** 固定 Head 的 `src/main/device-simulation/mcp-fixture.ts:89`，相关 cleanup `:81`。该缓存规则在原 `1317bf3` 已存在，属于本次明确要求检查的相邻清理失败路径，非 M1 新引入的授权回归。

**触发：** 正常建立 fixture 连接后，client.close 与 adapter fallback transport.close 各瞬时失败一次。adapter 正确撤下工具、标记 disconnected 并保留资源供重试；wrapper 继续关闭 server/listener，最后抛 E_SIM_MCP_CLOSE。第二次 connection.close 直接返回首次 rejected promise，未再次调用 adapter。

**独立最小复现，已执行 exit 0：** 用 `git show 09a0651` 编译固定源码；真实 SDK 1.31.0、HTTP、adapter、registry，仅 RAG 环境依赖替身；在 Client/SSEClientTransport 原型上各注入一次明确关闭故障，连接建立本身未模拟。

```json
{"head":"09a065127d80c1b7d1fe0c52cb036f8f473c7721","case":"wrapper-close-retry","first":"E_SIM_MCP_CLOSE","second":"E_SIM_MCP_CLOSE","clientCalls":1,"transportCalls":1,"state":{"connected":false,"toolCount":0}}
```

恢复原 close 方法后显式 `disconnectMcpServer(serverId)` 完成资源释放，探针进程正常退出。没有正常运行 app、写 mcp-servers.json 或操作真实设备。

**影响与分级：** 错误有明确返回，工具已撤下、旧 closure 已失效，但原连接句柄无法在瞬时故障消失后完成资源重试；宿主仍可用既有明确 disconnect 清理。影响限于显式模拟 harness 的残留资源，定 Minor，不升为 Important。

**最小建议：** cleanup 拒绝时清空本次缓存 promise，保留成功幂等和并发 close 合并，后续仍使用原 adapterOwner；新增真实 SDK 的一次失败后重试回归。执行器已确认一并在有界清理模块中处理，本轮固定 Head 尚未修复。

## 实际验证与证据限制

本席没有重跑任何既有通过套件或全量。重新读取的实际归档：

| 证据 | 归档及真实结果 |
| --- | --- |
| M1 真实 RED | `device-simulation-closure/m1-real-red.log`；report `2026-10-18T06-00-14-660Z-3d6fad70-7c68-4b9b-bb74-15453a56df3f`：1 failed / 10 passed；仅预期替换清理用例失败，0 unhandled。 |
| ownership RED | `ownership-red.log`；report `2026-10-18T06-02-12-143Z-224aa86a-6f9b-4478-b45a-c579e11cad64`：5 failed / 35 passed，5 项均为对应行为失败，0 unhandled。 |
| scoped GREEN | `m1-green.log`；report `2026-10-18T06-03-31-362Z-ea781138-d4b4-41ff-adc3-29e7575e5d34`：248 passed、16 files、84 device cases、0 skipped/unhandled。起止相同的提交前 working diff，基于 `1e587d1`，diff SHA256 `2749c90a10ca2dc54d46cac513fbfe47a4bb0a70d7fbadfb87cb95f463d374a0`。 |
| complementary GREEN | `complementary-green.log`；report `2026-10-18T06-06-47-278Z-9cfd6256-e05d-45ac-9c8e-f3e6c765d79c`：168 passed、12 files、0 skipped/unhandled；clean `09a0651` 起止。与上述 16 个文件无重叠，合计 416 项/28 文件。 |
| Main/storage | 执行器记录 Main tsc --noEmit exit 0，`main-types.log` 实际为空；本席未重跑编译，不以空日志单独证明 exit code。`storage-boundary.log` 实际为 PASS：88 accesses / 46 files。 |
| prior full | 实际原 report `device-simulation/test-reports/2026-10-18T05-38-34-633Z-c259ec29-1838-4494-aa2a-4cee8c2cb290/report.json`：clean `0a5fe23` 起止，10838 passed / 11 existing skips / 0 unhandled；这是旧 Important 修复批次证据，不是 adapter/M1 或后续修复的最终全量。 |

248 组不是 clean `09a0651` 执行：本席计算固定四源码提交差异 SHA256 为 `d72c567f0d29d3a2d938eb855380ab340447242a401d90ecab737f3c7af64f4d`，与归档 working diff 不同。执行器明确说明 GREEN 与 Main tsc 后只为两个 public 函数补两行说明注释，并新增用户文档段落，再提交 `09a0651`。本报告据实保留提交前证据身份；没有把执行器时序说明当作本席复算出的字节等价，也未为注释映射重跑测试。最终新代码的 clean 全量仍待后续一次执行。

本席新执行仅两项最小疑点探针：I2 runtime ENOENT（真实存储/controller、注入 port），M2 瞬时双关闭失败（真实 SDK/HTTP/adapter/registry）。首次受 sandbox 限制的 I2 探针在 fs.realpathSync.native 处 EPERM，未进入 fixture/RPC，随后 cleanup 的同类 EPERM 遮住原 preflight 错误并留下自有临时目录。检查具体路径及 nonce marker 后，用 require_escalated 完成限定探针并清理该目录；后续 M2 也按授权使用原生操作。未遭自动审批拒绝，没有未知执行结果。所有 `review-probe-*` 自有临时 profile 均按 canonical audit 子路径、basename 和事先 nonce marker 核对后移除；连接显式释放。唯一持久写入为本报告。

## Considered and declined

- **accepted 后撤权或期限过后 provider completion：** 沿用既有 uncertainty 语义，撤权不能证明已受理操作未发生；没有要求回滚或改成 not_applied。
- **owner 身份作为安全沙箱或 domain 授权：** 它只约束 Main 资源清理。可信宿主仍可不传 owner 使用既有 API，或以变更配置替换连接；这不是给 MCP caller 新 grant。
- **返回已知终态/approved 时 reconcile 不做健康读取：** 该短路没有发 port/RPC 或写日志，不违反本次“外部动作前检查”要求。
- **取消态与迟到 accepted 的人为交错：** 公共 API 不允许取消已发送命令；共同终态保护包含 cancelled，但没有为不可达时序要求额外 mock。
- **恶意同进程改私有字段、复用/篡改 owner 对象、修改原 ToolDefinition 对象而不替换引用：** 可信宿主对象模型不提供对抗同进程恶意操纵的隔离；精确引用是当前明确要求。
- **合法格式 journal 的恶意完整重写或 rollback：** 现有 schema/digest 不是密码学真实性或 anti-rollback 证明。此次 I2 缺失文件问题没有依赖这种范围外能力。
- **主动同用户并发替换祖先目录、OS crash recovery、跨进程 exactly-once、自动清理 stale lease：** 均为原已裁定边界；未新增恢复机制或作更强保证。
- **SSE deprecated、迁移 transport 或升级 SDK：** 复用本机 1.31.0 和现有 host 是固定范围；没有重开等价 upstream 研究或提新依赖。
- **真实账户/设备/遥测/GUI 确认、凭据、厂商 receipt：** 明确不在授权内；测试 fixture applied 不宣传为真实设备成功。
- **通用 adapter 原有日志的全面重构/额外脱敏审计：** 本次 owner 未序列化，fixture tool 参数仅为非秘密 operationId/固定动作；未增加真实凭据数据路径，没有证据支持扩成通用日志工程。
- **测试覆盖率百分比、性能预算、npm audit、全仓 mutation：** 未新增依赖或发布，既有容量上限沿用，且本席只读；没有新增测量或宣称这些指标达标。
- **部分注册/旧 callback 的组合爆炸测试：** 精确引用和双重 client 身份条件已逐段检查，现有 lifecycle 回归覆盖相邻失败/替换路径，没有发现额外确定错误；未为记账重跑通过套件。这里不将静态判断包装成新执行证明。

## Assessment

本轮固定 Head：**Critical 0 / Important 1（I2 未完全闭合）/ Minor 1（M2）；原 M1 0。** I1 与 M1 的修复符合授权且保留异步回执、撤权、日志/lease 和权限边界；I2 的 runtime missing journal 变体必须修复。M2 是可恢复资源失败后的句柄重试缺口，建议同一模块最小修复。

**尚不应启动最终全量。** 执行器已开始处置 I2/M2，将提供新固定提交和相应 RED→GREEN 证据；同一独立审查席只对这些增量复核后再判断是否可进行一次最终 clean 全量。没有权限/工具审批遗留阻塞；实际审查阻塞为本报告的 I2，最终版本全量证据尚待完成。本结论不授权推送、PR、合并、打包、真实设备或下一阶段工作。
