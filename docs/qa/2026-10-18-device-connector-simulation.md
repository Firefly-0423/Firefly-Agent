# 设备 Connector 模拟：实施、审查与验证

## 最终全量结果

`npm test` 在干净 `0a5fe23e14657be12cac02ee818472c3194e69ac` 开始和结束，2026-10-18T05:38:34.634Z 至 2026-10-18T05:52:11.228Z。实际 10838 通过、0 失败、11 跳过、0 未处理异常；设备模拟 83/83。archive SHA256 `bed609d25b2b707319ad7e2c5e1c14a46ffbf39adf4f4105d95664fa055ad2ac`。详见 [verification JSON](2026-10-18-device-connector-simulation-verification.json)。


本批次在独立分支 `codex/device-connector-simulation-20261018` 上实现受控模拟。基线为外部技能市场整合后的 `eac3e67`；计划先于代码提交，最终受测代码为 `0a5fe23`。这是显式调用的 test/smoke harness，未接入正式启动或 GUI，不构成真实设备 Connector 发布。

## 实现与边界

| 层 | 源码与职责 |
| --- | --- |
| 固定契约 | `src/main/device-simulation/contracts.ts:60` 严格动作类型/范围；`:106` 回执精确关联；`:120` 持久化 schema。所有公开设备 DTO 标记 `simulation:true`。 |
| 隔离持久化 | `journal.ts:48` 校验路径、普通文件、单硬链接、lease；读取另校验大小与完整 JSON/schema；通过既有 AtomicJsonStore 写入。仅允许有 isolationRoot 的 test/smoke profile。 |
| 授权与生命周期 | `controller.ts:68` 统一持久健康/所有权检查；`:112` 先持久化 dispatching 再发送；`:130` 验证回执与保持终态；`:148` 仅查询回执进行恢复。 |
| 真实 MCP 路径 | `mcp-fixture.ts:39` 自建 127.0.0.1 临时 SSE listener，使用既有 SDK 1.31.0、adapter、ToolRegistry。仅四种 read/preview/execute/receipt 工具，execute 参数仅为 operationId；不写 mcp-servers.json。 |

固定 fixture 为灯、空调、窗帘。灯支持布尔开关和整数亮度 0–100；空调支持开关、cool/heat/fan 与 16–30°C、0.5°C 步长的目标温度，目标温度不冒充实际室温；窗帘整数位置 0–100，明确 0=关、100=开。未知设备/动作/字段、类型转换与越界值均拒绝。

授权默认拒绝，按 owner、设备、动作限制，session 使用进程内对象身份。预览不产生 fixture 或日志写入；预览绑定完整意图、revision、epoch 与 30 秒期限。明确确认仅存在于可信 harness API，不作为 MCP 工具。执行前重新验证授权，provider handler 再独立检查。通用 allow_all 或工具 annotations 不能提供领域授权。

最多 32 个预览、128 条 journal 命令、1 MiB journal、16 KiB HTTP JSON body。HTTP 校验 Host、Origin、路径、session 和 Content-Type。路径/lease/JSON 失效后，在 receipt port 和 listener/连接之前拒绝。

发送后超时、失联、取消或异常回执均保持 unknown，不自动重试、不推断未生效、不自动回滚。provider 的 fixture 效果与回执同一次原子写入；相同 operationId 不重复施加效果。正常关闭重建后只查回执，不重发；旧 owner 的迟到响应不写入新 owner。applied 仅表示 owned fixture 的持久完成记录已被关联验证，不能外推为真实设备证明。

## 独立审查与一次修复

一次独立 gpt-6.1-sol/max 审查范围为 `eac3e67..1317bf3`，原始结论为 Request changes：0 Critical、2 Important、1 Minor。原始报告不改写，见 [独立审查](2026-10-18-device-connector-simulation-independent-review.md)。未再次派发审查，也不把修复后的测试等同独立重新批准。

- I1：同一命令先经 reconcile 验证 applied/rejected，迟到 accepted 会回写并降级终态。先补两个失败断言，随后统一 acceptReceipt 保持已验证终态，不再写入旧回执。
- I2：运行中 journal 损坏或 lease 丢失后，receipt 查询和 wrapper 启动缺少前置完整健康检查。先补四个失败断言，随后统一 assertReady，在发起查询、创建 listener/连接、处理 fixture MCP 前校验，不用磁盘 reload 覆盖当前内存状态。
- 两项合计 RED 6 失败/37 通过；GREEN 404/404，27 个文件，其中设备模拟 83 项，0 跳过、0 未处理异常。Main 类型检查 exit 0。
- M1 延期：若可信宿主主动替换模拟随机 namespace 中的一项 ToolDefinition，close 可能跳过 adapter disconnect，留下旧工具/client，仍报告成功。独立审查已实际复现，常规关闭覆盖未触发此分支；异常路径需显式 disconnect。未扩展通用资源所有权 API。

## 验证方法与限制

契约/journal 单元测试、controller 受控 port 故障注入与真实 SDK/HTTP/adapter/registry 集成分层执行。集成中仅 Electron/RAG 环境模块采用替代，另有明确 provider 故障注入；没有把受控 port 的消息时序当作真实 SSE 重排复现。

TDD 证据包含：契约/journal 39 项、controller 组合 66 项；MCP 初始 6 项失败；回执伪造和非 Error 拒绝均先观察失败再修复。最初 Host 反例使用 fetch 时被客户端规范化，改用真实 native HTTP 发送原始 Host，产品 guard 和断言未放宽。最终审查修复组合 404 项；Main 类型检查通过，未修改的存储边界检查 PASS：88 accesses / 46 files。

沿用任务自有依赖、合成用户目录与临时目录；敏感环境变量剥离，npm 生命周期禁止。显式空 Electron runtime override 阻止隐式下载/启动。本批次无新安装/下载、候选代码执行、付费模型调用、SDK/EXE 打包、真实凭据/账户/设备、正式配置、GUI 安装、push/PR/merge。第一批曾发生的 Electron 意外下载及清理保留在其历史 QA，本批次没有重演。

正常 close/重建有测试；异常 OS 退出遗留 lease 时 fail-closed，没有自动清理或离线恢复工具。未验证 OS crash recovery、跨进程 exactly-once、主动同用户并发路径替换、远端厂商真实性、真实 GUI 确认、硬件延迟或遥测；不声明覆盖率百分比、mutation coverage 或性能预算达标。

## 裁定（按发生顺序，含代价）

1. 具体 spec/plan 就绪后内联执行，不再增加技能阶段确认：主会话已明确授权继续。代价是方案若有偏差需本地修订。
2. 仅 owned fixture wrapper 复用既有 SSE 兼容传输：遵循现有宿主。代价是未来传输变更需适配 wrapper。
3. 陈旧 lease 拒绝自动接管：有界 JSON 方案缺少可靠跨平台 CAS/owner 证明。代价是异常退出需离线核验恢复。
4. task-done 检查刚归档的执行结果与源码哈希，不为记账重跑已通过测试：遵循禁止冗余重跑指令。代价是旧证据风险，由哈希/提交映射约束。
5. 一次新审查安排在 scoped green 后、最终全量前：避免修复前重复全量。代价是审查员未持有最终全量，交付仍保留这一最终门槛。
6. 已 accepted 的 deferred 命令可在本地撤权/过期后完成：撤销不能证明既已受理的效果未发生。代价是真实 Connector 前需重新审视完成语义。
7. 不承诺跨进程、OS crash 或主动同用户竞态隔离；陈旧 lease 继续 fail-closed。代价是异常恢复仍为离线所有权任务。
8. 不提供 journal 密码学证明：保证为 owned fixture 关联校验。代价是完整合法重写的本地 journal 不具备独立真实性证明。
9. 保留现有 SDK 和 SSE 兼容路径并记录 deprecated：满足复用要求。代价是未来宿主升级需适配。
10. 不加入真实账户、设备、GUI、遥测或凭据能力：遵循模拟边界。代价是本批次不能直接用于真实设备。
11. 信任 harness 时钟、进程内对象/常量及宿主创建的 session：无 MCP JSON 控制路径。代价是不隔离同进程恶意操纵。
12. 不新增性能预算、依赖升级或 npm audit：依赖未变，且不发布并有固定容量上限。代价是没有新的量化性能/漏洞结论。
13. 审查不做源码 mutation：审查授权只读，采用原源码的临时 profile 合成复现。代价是 mutation coverage 未测。

## 交接

原始外部技能 batch/tail/integration refs 和提交均保留。设备分支只新增模拟源文件、测试和文档，不改通用 adapter/manager、依赖锁定文件或正式 bootstrap。详细源码哈希、实际全量起止 revision、跳过项、原始 archive 和独立审查证据随 verification JSON 与本地 audit 一并保存。后续集成需另行授权；本批次保留分支及工作区。
