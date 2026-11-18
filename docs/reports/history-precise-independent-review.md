# H 精确失效独立审查报告

日期：2026-10-18。审查模型：gpt-6-astra，reasoning effort：medium。

审查工作树：`E:\Codex\2026-10-17\task\firefly-history-precise`。基线：`a38c34829b5d6265b6f6f03b2d642f584ec05340`（简称 `a38c3482`）。审查对象为该基线之后的未提交实现及相关测试差异，包括新增的 `history-origins.ts`；本报告不是某个已提交版本的合并批准。

## 最终结论

**代码审查通过。** 下列各轮发现的实质问题均已在最终只读复查中确认修复，未发现新的确定安全阻塞。全量测试、Electron 验证以及父任务正在补充的场景，须由父任务提供独立运行证据；本报告不将其报告的通过结果表述为审查者亲自运行所得。

重点检查了实际 claimed context 的 M/H/S/current transcript 来源闭包、持久输出绑定、事件及文档撤销传播、旧未知数据隔离、最终 Worker 事务重验证、锁顺序、失败路径与 schema v12 迁移。实现检查期间未修改源码；获授权后仅新增本报告。

## 各轮发现与处理

### 第一轮：初版实现

1. **Required：S 流式回复未登记持久来源。** 初版仅 default-run 向 `commitResponse` 传入输出 entry；S 路径的 user 与成功 assistant 缺少登记，导致更正或遗忘后的新历史仍不可恢复。
   - 修复：`src/main/memory-context/main-s-runtime-port.ts:84` 登记可信 user；`:119` 捕获原 assistant entry，`:125` 在成功 settlement 写入路径传入它。`src/main/memory-context/main-context.ts:372` 在成功写入后登记来源。
   - 复查：没有将 `assistant_settlement` 误当作 assistant 事件，也没有在仅触发 mutation observer 时就授予成功输出来源。

2. **Required：投影片段超预算抛硬错误，可能终止当前聊天。** 初版逐原子组生成文档，超过 128 片抛 `MEMORY_HISTORY_INPUT_INVALID`，不属于 scoped history 可降级的覆盖不足结果。
   - 修复：`src/main/memory-history/history-repository.ts:195` 合并连续安全原子组；`src/main/memory-sources/native-history-provider.ts:84` 将超预算转换为 `selection-budget-exhausted` / `MEMORY_HISTORY_COVERAGE_INSUFFICIENT`。
   - 复查：保留工具配对原子性，并传播部分覆盖状态。

3. **Required：Summary 闭包包含未发送的输入。** 初版遍历全部 `sourceDeps/transcriptRefs`，使预算舍弃的事件仍影响后续回复。
   - 修复：`src/main/memory-context/context-repository.ts:175` 按实际 `segments/transcriptSegments` 展开依赖，完整输入继续作为当时验证 guard。

### 第二轮：来源范围与生产路径

4. **Required：source-bound H excerpt 闭包过宽。** 初版对整份 H 的 `sourceDeps` 建立依赖，再切片 provenance；未发送片段的更正或遗忘会误伤输出。
   - 修复：`src/main/memory-context/context-repository.ts:179` 先选取实际 excerpt messages/provenance，再从选中 message 的 sourceRef 递归展开 derivedRefs。

5. **Critical：Channel 普通读锁重入死锁。** 新增登记在 `store.withReadLease` 中调用 `recordHistoryUser → readSource → registry.readEvidence → channel-source-provider.withLease`，再次等待同会话普通读锁，并可能占住 actor coordinator。
   - 修复：`src/main/memory-context/main-context.ts:433` 仅执行 checkedRef 和 coordinated Worker 命令；producer 在进入 canonical store lease 前已完成可信来源验证和读取。
   - 复查：登记函数不再触发 provider I/O；未发现新的确定重入死锁。

6. **Critical：独立时钟相等校验误杀 Desktop 聊天。** 初版要求 source observation.occurredAt 与 transcript entry.at 相等，但两条生产路径独立取时；固定时钟测试容易掩盖该问题。
   - 修复：`src/main/memory-history/history-origins.ts:52` 的 `recordUser` 去除独立时间戳相等条件，保留 provider/session/turn、content revision、direct-user trust 和内容指纹验证。
   - 复查：未用文本相似度或时间接近推断来源；完整 entry digest 仍参与事件身份。

### 第三轮：H 移除的派生撤销

7. **Required：H remove 仅删除文档索引，派生回复仍可有效。** 初版输出闭包只有 event/source，缺少被消费 H 文档的删除状态；重新投影产生不同文档 ID 也可能避开原 tombstone。
   - 修复：`src/main/memory-context/context-repository.ts:178` 保存实际使用 H 的文档依赖；`src/main/memory-history/history-origins.ts:83` 检查 record、owner、incarnation 及 live 状态；`src/main/memory-history/history-repository.ts:217` 在删除事务内对 native provenance 调用 `revokeEvents`。
   - 复查：source-bound H 通过文档依赖传播删除；native 通过精确事件撤销阻止重新投影恢复。文档检查不要求 revision 不变，避免普通追加导致长期闭包误失效。

## 同期由父任务提出、由独立审查复核的修复

- **generation 0 未知 native 事件及旧缓存隔离：** `projectNative` 仅恢复 valid origins；`src/main/memory-history/history-repository.ts:146` 对 native 缓存要求持久 proof。未知数据不因尚未发生遗忘而获得可信身份。
- **重启后的稳定 owner：** `HistoryOrigins.recordUser/recordResponse` 仅保存 actor/provider/session，不将临时 bootId 混入 receipt，避免重复 user 登记的误冲突。
- **已有撤销状态不可解禁：** `HistoryOrigins.save` 保留不可变 proof，重复登记不会清除 revoked。跨会话 event 依赖递归检查撤销；delete/repair/rewind observer 在修改前持久撤销，失败修改保持保守失效。

上述两项父任务提出的问题不计为本审查者独立首发现。

## 验证证据与限制

本审查者曾尝试运行：

```text
node scripts/testing/run-tests.mjs src/main/memory-history/history-origins.test.ts src/main/memory-context/default-run-capture.test.ts src/main/memory-sources/native-history-provider.test.ts
```

运行在 `ArchiveReporter.onInit` 阶段退出：sandbox Temp 中的 `firefly-test-reports/.../report.json.tmp → report.json` 重命名返回 `EPERM`。**测试用例未执行；这不是测试断言失败，也不是通过证据。** 未申请提权、未重试。日志还显示既有 node_modules 将 Vitest 解析至相邻工作树的依赖目录；审查者未主动探索或修改该工作树。

此后按父任务指示仅只读复查，不再运行测试。父任务报告的局部测试通过、全量检查和 Electron 验证，应引用其另行保存的报告。本报告未独立复验运行结果，未执行源码变异测试，未读取真实用户数据库、凭据或调用外部服务。

最终未解决的代码审查 finding：无。剩余验证工作：由父任务完成并报告最终全量测试、类型检查及 Electron 验证。

## 最后增量：正常 Chat 写者发布 checkpoint

父任务随后提供授权范围内的必要修补：真实 Electron 验证发现普通 Chat 成功后未生成 snapshot，H 因 `SNAPSHOT_MISSING` 无法读取。修补限定为正常写者调用现有 checkpoint；独立审查检查了新增代码及相关测试差异，没有自行运行测试或 Electron。

- 位置：`src/main/orchestrator/firefly-agent.ts:556`。条件为 `executionMode === "chat" && !chatWithTools` 且 canonical terminal 为 success。执行发生在 Chat loop / controlled S 已返回成功之后，`RUN_FINISHED` 构造与发布之前。Work、Code 和带工具 Chat 分支未增加该调用。
- 权限与锁：使用本轮已绑定的 `runOptions.transcriptSink`，沿用 sink facade 和 `ConversationTranscriptStore.checkpoint` 的会话写队列。没有由 H 读取器写入、扩大文件目标或新增外部操作。checkpoint 不位于此前 append 持有的 guard 内，未发现新增同队列重入死锁。
- 故障：checkpoint 拒绝进入既有错误传播路径，不发布 success terminal。store checkpoint 写临时 snapshot 后 rename，未删除或重写 JSONL；已成功的 assistant / S settlement 保留。报告成功不早于 checkpoint 完成。
- 取消：订阅取消设置 `cancelled`，新增 await 前后均检查该标志，后续 terminal 被抑制。单纯 external AbortSignal 只记录 abortSource；在 canonical success 已提交后、checkpoint 等待期间发出的 abort 不撤销成功 settlement，checkpoint 成功后仍可能报告既定 success。不能将此描述成“任意晚到取消都会变成 cancelled”。建议用 pending checkpoint + external abort 合成测试固定此预期；这不是本轮发现的安全阻塞。
- 测试审阅：新增用例检查 snapshot 存在、checkpoint pending 时无 RUN_FINISHED、失败时保留 canonical entries 且无 success terminal。父任务报告已观察 RED 后 GREEN 79 cases；这是父任务提供的运行信息，审查者没有独立执行。去除人工 checkpoint 后的真实 Electron 重跑结果仍由父任务另证。

该最后增量的只读代码审查通过；最终代码审查结论保持通过，无新增未解决的 Required/Critical finding。
