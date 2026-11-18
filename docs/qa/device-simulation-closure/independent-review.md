# 设备模拟有界清理：最终独立复审

日期：2026-10-18。**当前发现：0 Critical / 0 Important / 0 Minor。I1、I2、M1、M2 均已闭合。已授权的模拟清理可进入执行器安排的一次最终干净全量验证。** 本结论不表示最终全量已经运行，也不授权合并、推送、PR、打包或真实设备能力。

## 固定版本、范围与方法

| 项目 | 版本 |
| --- | --- |
| 原修复复审 Base | `1317bf37e64e5a7184ec42bfce20ced3fe4763ad` |
| 初轮固定 Head / 本轮增量 Base | `09a065127d80c1b7d1fe0c52cb036f8f473c7721` |
| 本轮最终固定 Head | `e0ed0fac57dd0bdeee2a272e99637e221d453e9f` |
| I1/I2 原修复提交 | `0a5fe23e14657be12cac02ee818472c3194e69ac` |
| M1 修复提交 | `09a065127d80c1b7d1fe0c52cb036f8f473c7721` |
| I2 缺失日志 / M2 重试修复 | `e0ed0fac57dd0bdeee2a272e99637e221d453e9f` |

同一审查席延续初轮，只检查新授权的具体修复增量，未派其他 agent，未重做外部市场或 upstream 研究。开始检查时 HEAD 为 `e0ed0fa`、工作树干净；产品源码使用固定 `git show e0ed0fa:<path>` 阅读。本席没有改变产品工作树、index、HEAD、分支、配置或依赖，没有安装、下载、调用真实设备/账户或启动普通 app。

沿用已读取的 Senior Code Reviewer 模板、AGENTS.md、code-review-and-quality、differential-review、security-and-hardening 及现有 spec/plan/质量边界。初轮的 I2/M2 是先独立最小复现再提出建议；本轮使用新增实际 RED→GREEN、固定差异、源码哈希和控制流检查，没有为记账重跑已通过测试。

初轮原始报告完整保留：[independent-review-initial.md](independent-review-initial.md)，SHA256 `dae45fc4fd3b17e217d51ced73a1ed695d1c852ee0dec28cbe70e33b4417b7e3`。它对 `09a0651` 的 1 Important / 1 Minor 结论没有被改写。本报告是后续修复的增量处置，不把旧报告当作最终批准。

本轮全量读取并检查的六个增量文件（80 additions / 3 deletions）：

- `src/main/device-simulation/journal.ts`、`journal.test.ts`。
- `src/main/device-simulation/mcp-fixture.ts`、`mcp-fixture.integration.test.ts`。
- `src/main/device-simulation/controller.test.ts`。
- `docs/device-connector-simulation.md`。

结合初轮已完整检查的 controller、contracts、adapter lifecycle、registry/manager、AtomicJsonStore、runtime-profile/StorageContext 与本机 SDK 1.31.0 上下文。本次没有重复审查无变化的等价实现。最终 controller、contracts、adapter 及对应旧回归未被本轮改动，相关文件又纳入了源码哈希核对。

## 闭合结果与理由

| 问题 | 最终结论 | 固定 Head 证据 |
| --- | --- | --- |
| I1：迟到 accepted 降级已验证终态 | **闭合** | `controller.ts:132` 的共同 acceptReceipt 终态保护保留，未被本轮改动。最终 GREEN 中 applied/rejected 两种交错均 passed；检查最终 view、日志字节、verifiedReceipt 与 pending 的回归仍在。没有新增发送、重复 effect 或 replay。 |
| I2：失效日志/lease 后仍查询或建 listener | **闭合，包含 runtime ENOENT 变体** | 原 assertReady 的 session、路径、lease、大小和 schema 检查保留；新增 `journal.ts:33`、`:55`、`:65`、`:73` 的 materialized 规则阻断本实例已持久化/观察主日志后消失，以及重开仅剩备份的情况。对应 read/write、receipt 零调用和 listener 零创建五项回归实际 RED 后 GREEN。 |
| M1：替换一项工具后遗漏原 adapter/client，或误删后来资源 | **闭合** | adapter 的精确 ToolDefinition 引用检查和 fixture 私有 adapterOwner 未改。最终 GREEN 包含真实 SDK 替换后释放、保留替换项、旧 closure 拒绝，以及 mocked lifecycle 的 disconnect/remote-close 保留替换项、旧 owner 无法关闭后来 client、不同 owner 不合并。 |
| M2：失败 closePromise 永久缓存，不能重试清理 | **闭合** | `mcp-fixture.ts:89` 只在 cleanup rejection 后清空缓存并重抛。成功 promise 仍保留，并发调用仍合并。后续重试仍调用 `disconnectMcpServer(serverId, adapterOwner)`，没有新连接或 domain dispatch。真实 SDK/HTTP 双瞬时关闭失败回归实际 RED 后 GREEN，第二次 close 完成释放。 |

I2 的 flag 位于拥有该语义的 SimulationJournal，没有修改通用 AtomicJsonStore 的首次 fallback。首次主日志与备份均不存在时仍可无日志只读初始化；读到主文件或成功写入后记住 materialized，guard 在 store.read/write 前拒绝缺失主文件。重开时备份存在也建立此事实，不加载备份恢复或以缓存重建日志。状态只是进程内布尔标记，没有新持久文件或迁移。

新 controller 回归对健康失败的正确断言为：本次返回 unknown、effectState unknown、retryable false，receipt 未被调用，主日志未重建、移走的原字节未改，原内存 pending 仍为 accepted。它保留既有“无法持久保存故障时返回保守结果、缓存保持原值”的语义，没有为变绿修改 controller 状态机。

M2 只在资源释放失败后允许另一次显式 close。catch 清空缓存后重抛，首批并发调用者仍收到同一失败；后续调用才发起新的 cleanup，成功后保留幂等。per-ID adapter 队列、原 owner 比较、精确 registry 引用检查以及旧 client callback 的身份检查均保留。若可信宿主已经替换同 ID 连接，旧 fixture 的重试不能关闭后来连接。

撤权、发送后取消、receipt uncertainty、终态单调性和 lease 边界未被放宽：session/approval 仍由进程内对象及原 session 绑定；provider handler 独立检查；effect/providerReceipt 同一次原子写；无自动重发、反向动作或 unknown→not_applied 推断。资源重试不执行设备命令。正常 manager/权限/日志配置没有新增字段或授权路径。

五轴检查没有发现新问题：改动集中在 journal 健康语义和 wrapper 资源生命周期，错误码固定，类型与职责清晰，未增加依赖；额外存在性检查在原同步、有固定容量的 journal 操作中执行，无新无界循环或远程调用。本席未作性能预算或覆盖率百分比声明。

## 实际验证与版本映射

本席重新读取实际 report JSON、对应日志及源码映射。以下运行由执行器实际完成，本席没有重复运行套件：

| 执行 | 实际结果及身份 |
| --- | --- |
| 首次 missing-journal RED | `missing-journal-red.log`：5 failed / 53 passed，0 unhandled；对应本轮确认的五个 I2 反例。 |
| 首次修复尝试 | `missing-journal-green.log` / report `2026-10-18T06-12-49-695Z-a581bd2d-3806-4a7f-ba69-90327b576471`：1 failed / 127 passed；新增测试错误预期 accepted，而既有健康失败返回 transient unknown。该失败被保留，未当成 GREEN。 |
| 校正后的六项 RED | `final-review-red.log` / report `2026-10-18T06-14-24-620Z-38d80e0c-a3ab-4dfb-91fc-ed453b6e47b7`：6 failed / 53 passed、3 files、0 unhandled，起止 revision/diff 相同。带新增测试的工作树，五项 I2 与一项 M2 均实际失败；不宣称这是 clean Base 运行。 |
| 最终 scoped GREEN | `final-review-green.log` / report `2026-10-18T06-15-26-595Z-8ca194c6-389b-439b-a569-6e68c39024c1`：158 passed、8 files、90 device cases、29 adapter lifecycle cases，0 failed/skipped/unhandled，起止 working diff 相同。 |
| Main 类型检查 | 执行器记录 `tsc --noEmit` exit 0；`final-main-types.log` 实际为空。本席未重跑编译，不把空日志单独当作 exit-code 证明。 |

校正测试时保留并加强了零 receipt、无重建、原字节、pending accepted 的断言。随后将 journal 修复撤回，观察到这些校正后的五项 I2 及 M2 一并 RED，再恢复同一修复并获得最终 GREEN。没有通过跳过/删除反例或降低断言要求隐藏失败。

**最终版本证据已字节映射：** 本席计算

```text
git diff --binary 09a065127d80c1b7d1fe0c52cb036f8f473c7721 e0ed0fac57dd0bdeee2a272e99637e221d453e9f
SHA256 = dc6216f3bb420ee81cd6143e699984353ea7feb4c08ce1784dc1f7611df6efcf
```

该值与最终 GREEN report 的 `revision.diffSha256` **完全一致**。另核对 `source-hashes.json` 的 10 个源码/测试文件：当前 clean 工作树原始字节 SHA256 全部匹配；仅作仓库既有 CRLF→LF 规范化后，全部与固定 `git show e0ed0fa:<file>` 内容一致。因而该提交前稳定 GREEN 与最终固定代码有实际内容映射，没有沿用初轮“注释后改动”的未等字节情况。

最终 GREEN 的八文件是四个 device 文件、adapter lifecycle、AtomicJsonStore、runtime-profile 和其文档回归。controller 的故障/时序用例使用 controlled port；M2 重试与 M1 替换清理走真实 SDK/HTTP/adapter/registry，只有 Electron/RAG 环境依赖及明确的一次 close 失败注入。listener 缺失日志用例证明在 http.createServer 前拒绝，不把“未创建网络连接”的拒绝测试宣传为真实 RPC 成功。

先前证据保留其各自版本身份：初轮 248 passed/16 files 与互补 168 passed/12 files 共 416 项、文件不重叠；后者 clean `09a0651`，前者为提交前稳定 diff。新 158 组与它们有重叠，**不累加为 574 个唯一测试**。原 full 在 clean `0a5fe23` 起止得到 10838 passed / 11 existing skips / 0 unhandled，只证明旧模拟批次。既有 storage-boundary.log 为 PASS 88 accesses / 46 files。

**本最终代码的全量尚未运行。** 按授权由执行器在本复审处置后只运行一次，并记录 clean 起止 revision、实际 counts、skips/unhandled 和必要类型/边界结果。本席本轮没有执行额外 native 探针：六项具体反例已有对应实际 RED/GREEN，并完成固定 diff 和十文件哈希核验，没有尚未覆盖的具体疑点需要重复执行。

## Declined to judge

- **accepted 后撤权/过期仍由可信 harness 完成：** 既有不确定性模型允许已受理效果完成；撤权不能据此证明 not_applied，没有要求回滚。
- **新实例启动前主日志和备份都已被完全删除：** 没有可供该实例观察的持久记录，仍按明确保留的首次初始化处理。本修复记住本实例的观察/写入及剩余备份，不提供跨实例 anti-rollback 或新的持久存在性证明。
- **主动同用户并发替换路径/文件造成检查使用竞态：** 原已裁定非 OS 安全隔离范围；本次不引入文件句柄事务或跨进程 CAS。正常已持久化后丢失与重开仅剩备份均已覆盖。
- **合法 journal 被完整恶意重写、恶意同进程更改私有字段/owner/ToolDefinition：** 本地 schema/digest 与对象身份不是密码学 attestation 或同进程安全沙箱；本次没有扩大承诺。
- **不传 owner 的可信 Main 调用可断开/替换连接：** 这是刻意保留的既有宿主 API。optional owner 约束资源归属，不提供 domain 权限；MCP/config 无法提交该对象。
- **reconcile 对 approved/已验证终态直接返回内存：** 无 port/RPC 或持久写入，不要求额外 durable check；本次 I2 的外部动作前检查没有被绕过。
- **不可达的 cancelled 与在途 accepted 人工时序：** 公共 API 不允许取消已发送命令，共同终态保护仍包含 cancelled；未为同进程篡改制造新测试要求。
- **自动恢复缺失日志、备份回放、stale lease 接管、OS crash recovery、跨进程 exactly-once：** 均超出原范围；新代码选择拒绝，未加入恢复工具或自动删锁。
- **M2 的自动无限重试：** 修复只允许调用者显式重试资源清理，保留固定失败与成功幂等；未要求后台调度或 retry policy。
- **SSE 弃用迁移、SDK 升级、新 transport/真实设备/账户/GUI/凭据/遥测：** 明确不在本批授权内；沿用现有宿主和本机 1.31.0，不重做等价 upstream 研究。
- **通用 adapter 日志全面重构、依赖审计/升级、性能预算、覆盖率或源码 mutation：** 没有新秘密路径、依赖或发布；本席授权只读。保持原边界，不新增无关工程或声称未测指标达标。
- **重复组合套件、再派审查员、复审期间全量：** 用户明确要求同席增量及去重；已实际核对覆盖和版本，没有为记账重跑。

## Assessment

**当前无未处置 Critical、Important、Minor；M1 和 M2 均无遗留。** I2 的初轮 runtime 缺失日志问题已由最小 journal 修复及五项行为反例闭合；M2 由只清空失败 promise 的最小修复及真实 SDK 重试反例闭合。I1/M1 保持前轮审查结论，并在最终 scoped GREEN 中再次有相应行为证据。

**可进入一次最终 clean 全量验证。** 没有待审批、被拒或结果未知的行动，没有本轮代码审查阻塞。剩余门槛是尚未执行的最终版本全量及执行器的真实结果归档；它不应被本报告或旧全量替代。仍严格限于已授权模拟清理，不开展下一阶段。
