# 测试断言整改施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-test-assertion-hardening.md](./2026-11-15-test-assertion-hardening.md)

## 1. 当前状态

- 分支：`feat/test-assertions-t3`（基于 `feat/test-assertions-t2`）
- 进行到：施工包 T3 完成（T1、T2 记录保留在下表）

## 2. 已完成项

| 任务 | 改动 | 反向验证 | 验证 |
|---|---|---|---|
| T1.1 工具参数 | `tool-protocol.test.ts`：非法参数断言 `ToolCallArgumentsError`；保存失败断言原错误 `synthetic disk failure` 透传 | 解析器改抛普通 `Error` → 4 项失败 | 文件 39 项通过 |
| T1.1 MCP 连接失败 | `mcp-adapter-security.test.ts`：断言原样抛出同一个错误对象（`rejects.toBe`），并且没有 `listTools`、没有 `callTool`、没有注册工具、没有残留连接状态 | 去掉连接失败后的 `forgetMcpState` → 失败 | 3 个 MCP 文件 33 项通过 |
| T1.1 MCP 启用回滚 | `mcp-manager-enabled.test.ts`：断言 `ATOMIC_JSON_WRITE_FAILED` | 未做：错误来自测试替身本身，没有可改坏的实现 | 同上 |
| T1.1 Playwright 注册失败 | `sync-mcp-builtin.test.ts`：表驱动；断言 `console.error` 只调用 1 次、参数为固定前缀和分类原因（`failed` / `timeout`），只注册一次，没有移除 | 日志改为输出原始 `error` 字段 → 失败 | 同上 |
| T1.2 越界写入 | `workspace-boundary.test.ts:184`：断言 `E_PATH_NOT_ABSOLUTE` / `invalid_arguments` / `not_applied`（相对路径 `../` 在路径形状检查就被拒绝，不是 `permission_denied`）；越界文件内容不变的断言原本就有 | 把 `fs-tools.ts` 的错误码改掉 → 失败 | 带 helper 运行，25 项通过 |
| T1.2 持有句柄时改名 | `workspace-handle.integration.test.ts:33`：断言 `EBUSY`，且改名目标不存在 | 未做：这是 Windows 平台行为，不是可以改坏的产品代码；连跑 3 次结果稳定 | 4 项通过 |
| T1.3 晚到的审批 | `agent-loop-cancel.test.ts`：审批放行后再断言 `dispatch` 只调用 1 次、事件列表与取消时一致。原测试已断言 `actual` 没被调用、`stream` 只调用 1 次，审查报告 C3 只缺这两点 | 未做：让晚到的审批重新执行需要改动调度器的多处取消检查 | 8 项通过 |
| T1.4 信封篡改 | `payload-codec.test.ts:18`：断言 `MEMORY_AUTH_FAILED` | 解密失败码改掉 → 8 项失败 | 3 个文件 65 项通过 |
| T1.4 伪造身份字段 | `history-migration.test.ts:22`：断言 `MEMORY_INPUT_INVALID`，并断言没有写入任何历史 | 未做：该码由多处通用校验共用，改坏一处不能单独证明 | 同上 |
| T1.4 跨主体读取 | `natural-job-repository.test.ts:138`：断言 `MEMORY_DATA_INVALID`，并断言原主体读到的任务状态不变 | 只删掉 `actorKey !== actor` 这一处检查后，读取仍被拒绝：另有一层（记录加密绑定）也挡住了跨主体读取。断言守住的是结果，不依赖某一层 | 同上 |
| T2.1 合同 | `main-memory-contracts.test.ts`：撤销循环改为 `[变化, 码]` 表（`MEMORY_RUN_CANCELLED` / `MEMORY_RUN_DENIED` / `MEMORY_RUN_PROFILE_CHANGED` / `MEMORY_RUN_SESSION_CHANGED` / `MEMORY_RUN_ENTRY_CHANGED`）；其余断言 `MEMORY_SESSION_MODE_DENIED`、`MEMORY_INPUT_INVALID`；冻结对象改写断言 `TypeError`（无产品错误码） | 逐个码改坏产品里的该码字符串 → 对应测试失败（见下） | 文件 11 项通过 |
| T2.1 Responses 绑定 | `main-responses-binding.test.ts`：:77 五种非法上限改为 `[输入, 码]` 表（均为 `MEMORY_CONTEXT_COUNTER_UNSUPPORTED`）；计数失败表（`MEMORY_CONTEXT_COUNT_FAILED`，溢出为 `MEMORY_CONTEXT_FIXED_OVER_BUDGET`）；嵌套结构表（`COUNTER_UNSUPPORTED` / `TOOL_PAIR_INVALID` / `REQUEST_CHANGED`）；其余 `COUNTER_UNSUPPORTED`、`REQUEST_CHANGED`。原有的 `counted`、`sent`、`touched` 断言保留 | 同上 | 96 项通过 |
| T2.1 上下文 | `main-context.test.ts`：来源失效表（pending/edited/deleted/recreated 对应 `MEMORY_SOURCE_PENDING` / `STALE` / `DELETED` / `STALE`）；删除后的 reconcile 断言 `MEMORY_SOURCE_DELETED`；响应校验断言 `MEMORY_SOURCE_PENDING` | 同上 | 67 项通过 |
| T2.2 摘要 | `canonical-summary.test.ts`：:65 改为 `[变化, 码]` 表（append/edit/regenerate 为 `MEMORY_CONTEXT_TRANSCRIPT_STALE`，delete 为 `MEMORY_CONTEXT_INPUT_INVALID`，forget 为 `MEMORY_CONTEXT_STALE`），并新增 `summaryCount()`（读 SQLite 里 `kind='summary'` 的记录数）断言没有生成摘要；首个用例提交后断言数量为 1 作为对照；其余 `TRANSCRIPT_STALE` / `TRANSCRIPT_PENDING` / `MEMORY_INPUT_INVALID` | 同上 | 21 项通过 |
| T2.2 响应历史并集 | `response-history-union.test.ts`：全部改为 `[输入, 码]` 表（`RESPONSE_PROGRESS_DENIED` / `RESPONSE_PROGRESS_STALE` / `MEMORY_CONTEXT_ACCESS_DENIED` / `MEMORY_DATA_INVALID` / `MEMORY_HISTORY_SOURCE_MISMATCH` / `MEMORY_HISTORY_STALE` / `MEMORY_HISTORY_ACCESS_DENIED` / `MEMORY_INPUT_INVALID` 等）；新增 `denies()`：拒绝前后 `context_records`、`history_records` 的全部记录逐字节相同 | 同上 | 29 项通过 |
| T2.2 有界准入 | `bounded-admission.test.ts`、`production-counting-admission.test.ts`、`openrouter-bounded.test.ts`：`MEMORY_SOURCE_PENDING` / `MEMORY_SOURCE_STALE`；原有 `sends` 计数断言保留 | 同上 | 通过 |
| T2.3 流式与集成 | `main-s-stream.test.ts`、`native-h-stream.test.ts`、`smh-integration.test.ts`、`memory-session-modes.test.ts`：参数化用例改为 `[输入, 码]` 表，其余逐处断言具体码（`MEMORY_CONTEXT_CANCELLED`、`RUN_STALE`、`SEND_UNKNOWN`、`STREAM_FAILED`、`STREAM_*`、`TRANSCRIPT_STALE`、`MEMORY_HISTORY_STALE`、`SETTLEMENT_UNKNOWN`、`MEMORY_INPUT_INVALID` 等）；原有的 `sent`、`assistants`、读历史等副作用断言保留 | 同上 | 79 / 29 / 23 / 通过 |
| T2.3 回归 | `phase3-review-regressions.test.ts`：`:18` 改为断言组装结果的消息列表恰好是那条 4001 字符的用户消息、`excluded` 为空；`:44/:47` 断言 `MEMORY_HISTORY_STALE` | 码部分同上；4001 字符断言未做（见偏离） | 9 项通过 |
| T3.1 历史库 | `history-repository.test.ts`：A11、A12 改为断言 `validate` 返回的文档（id、摘要、消息与摘录切片）；B8 改为 8 行 `it.each`，每行断言 `MEMORY_INPUT_INVALID` 或 `MEMORY_HISTORY_INPUT_INVALID`；其余断言 `MEMORY_SOURCE_PENDING`、`MEMORY_HISTORY_INPUT_INVALID` | 改坏产品里的错误码字符串 → 失败 | 见第 5 节 |
| T3.1 分词上限 | `history-query-quality.test.ts`：A17 断言 65535、65536、65537、65536+127 个全角字符都原样切成一个 token，65536+128 拒绝并断言 `MEMORY_HISTORY_INPUT_INVALID`。实际上限不是 65536，按真实行为断言 | 改 `history-ranking` 的长度上限 → 失败 | 同上 |
| T3.1 原生传输 | `native-history-transport.test.ts`：A18 断言挂起的读取以 `MEMORY_HISTORY_NATIVE_PROTOCOL_INVALID` 拒绝、之后 `assertLive()` 同码失败、没有再写 stdin、释放后 stdin/stderr 没有残留的 error 监听 | 改坏协议错误码 → 失败；去掉释放时的 `!error` 检查未能让“没有写入”失败（`kill()` 已先把通道标为关闭），这一条由前几项兜住 | 同上 |
| T3.1 其余 | `history-migration`、`history-origins`、`history-schema`、`main-transcript-provider`、`main-history`、`native-history-provider`、`main-source-router`（`MEMORY_SOURCE_ROUTER_DENIED`）、`source-registry`（`MEMORY_SOURCE_STALE`）、`native-history-zero-write.acceptance.ts`（5 种拒绝各自的码）：裸 `toThrow()` 改为具体码或具体错误 | 改坏错误码 → 失败 | 同上 |
| T3.2 压缩器 | `memory-compressor.test.ts`：A2–A4、C2、D3 改为断言 `commit` 的完整参数、`appendReflectionLog` 的内容、`console.warn` 的固定前缀；跳过与失败路径断言没有 `commit`、没有压缩日志、L2 没有归档或新增，`invokeLlm` 未调用保留一条用于证明没有调用成本 | 改坏重试与落盘逻辑 → 失败 | 同上 |
| T3.2 legacy 其余 | `memory-schemas`、`memory-store-durability` | 同上 | 同上 |
| T3.3 policy | `temporal-memory.test.ts`（B12 及另外 4 处：`MEMORY_POLICY_SUPPRESSED` / `MEMORY_REVISION_CONFLICT` / `MEMORY_CONTEXT_FACT_STALE` / `MEMORY_CONTEXT_STALE` / `MEMORY_SOURCE_STALE`）；`natural-job-repository`（`[输入, 码]` 表：`MEMORY_USER_SOURCE_DENIED` / `MEMORY_POLICY_FUTURE` / `MEMORY_SOURCE_STALE` / `MEMORY_SOURCE_INVALID` / `MEMORY_INPUT_INVALID` / `MEMORY_DATA_INVALID`）；`main-policy`、`natural-extraction-runner`、`natural-memory` | 改坏错误码 → 失败；`natural-extraction-runner` 的 profile 用例通过改坏 `model.assertCurrent()` 验证 | 同上 |
| T3.3 core、recall、database、shadow | `core/schema`、`core/source-ledger`、`core/storage-safety`、`recall/recall-schema`、`database/repository`、`database/worker`（`MEMORY_SOURCE_PENDING`）、`shadow/shadow-repository`、`shadow/shadow-service`（错误消息 `MEMORY_TRANSACTION_FAILED`） | 改坏错误码、DDL 与外键约束 → 失败；`worker.test.ts` 改坏后重新构建了 Worker 产物 | 同上 |

T3 由 Gemini 施工，我逐个提交单独检出复核（见第 5 节）。反向验证方式与 T2 相同：临时改坏产品里对应的错误码或校验，确认失败后用 `git checkout` 还原。

T2 反向验证方式：对每个断言用到的产品错误码（37 个 `MEMORY_*`），临时把产品源码里该码字符串改成另一个值（`M` 改为 `N`），跑 `src/main/memory/context`，确认改过的文件里出现失败，然后用 `git checkout` 还原。37 个码全部在对应的被改测试文件里引起了失败；结束后 `git status` 确认没有产品文件改动。

## 3. 排除（复核后不改）

| 位置 | 原因 |
|---|---|
| `src/main/features/channels/adapters/qqbot/qqbot-api-client.test.ts:177` | 紧接着已断言请求地址、方法和请求体 |
| `src/main/agent/tools/workspace-boundary.test.ts:185` | 已断言 `category: "permission_denied"` |
| `src/main/memory/core/storage-safety.test.ts:83/88/92` | 断言的是测试辅助函数本身抛出的断言失败，没有稳定码可言 |
| `src/main/memory/context/source-secret-mask.test.ts:26/49/65/70/84/87/96/98` | 这 8 处是 `.not.toThrow()`，断言的是“不抛”，不是拒绝路径；该文件的 `toThrow()` 扫描命中均为此类 |
| `src/main/memory/core/source-secret-screen.test.ts:11/41/52`、`core/windows-open-lock.test.ts:23`、`history/history-budget-stats.test.ts:92`、`shadow/shadow-service.test.ts:213` | `.not.toThrow()` 断言“不抛”，同一用例里都配了行为结果断言 |
| `src/main/memory/legacy/memory-llm-client.test.ts:75` | `not.toThrow(MemoryLlmTimeoutError)` 配对了 `/cancelled by external signal/` 的正向断言 |

## 4. 缺稳定错误码

| 位置 | 产品抛出的错误 | 现在改为断言什么 |
|---|---|---|
| `src/main/agent/mcp/mcp-adapter.ts` 连接失败分支 | 原样抛出底层错误，消息里可能带有连接信息（不写日志；上层 `mcp-manager` 会分类成固定原因） | 断言是同一个错误对象，并断言没有任何注册和残留状态 |
| `src/main/memory/context/main-memory-contracts.ts` 冻结的上下文对象 | 改写属性时抛引擎的 `TypeError`，不是产品错误（`main-memory-contracts.test.ts:110`） | 断言 `TypeError` |
| `scripts/verify/memory-context/context-fixture.ts` 注入的故障 | `SUMMARY_INJECTED_FAULT` 来自测试替身，不是产品码（`response-history-union.test.ts` 的 `after-first-reserve`） | 断言这个注入码 |
| `history-origins.test.ts:28`、`history-schema.test.ts:14`、`core/schema.test.ts:18/33`、`core/source-ledger.test.ts:22`、`recall/recall-schema.test.ts:12`、`database/repository.test.ts:34/36` | SQLite 的 `SqliteError`（约束或触发器） | 断言 SQLite 的错误信息 |
| `history/main-transcript-provider.test.ts:29` | 函数载荷触发 V8 的 `DataCloneError` | 断言 `DataCloneError` |
| `history/main-history.test.ts:113` | 改写只读对象抛引擎的 `TypeError` | 断言 `TypeError` |
| `legacy/memory-schemas.test.ts:15` | 只有文本消息，没有错误码 | 断言该消息 |
| `database/repository.test.ts:106` | Windows `fs.renameSync` 的 `EPERM` | 断言 `EPERM` |

## 5. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| T1 范围：`npm test -- src/main/agent/loop src/main/agent/mcp src/main/agent/tools src/main/memory/core src/main/memory/history src/main/memory/policy`，设置了 `FIREFLY_REQUIRE_WORKSPACE_HELPER=1` 和 `FIREFLY_TEST_BASH` | 174 个文件：173 通过、1 跳过；3049 项：3043 通过、6 跳过 | 2026-11-15 |
| `tsc -p tsconfig.main.json --noEmit` | 通过 | 2026-11-15 |
| T2 范围：`NODE_OPTIONS=--no-experimental-webstorage` `FIREFLY_TEST_BASH` `npx vitest run src/main/memory/context` | 33 个文件、624 项全部通过 | 2026-11-15 |
| T2：`tsc -p tsconfig.main.json --noEmit`（该配置排除 `*.test.ts`，不检查测试文件类型） | 通过 | 2026-11-15 |
| T2：`git grep -n "toThrow()" -- src/main/memory/context` | 只剩 `source-secret-mask.test.ts` 的 8 处 `.not.toThrow()`，已记入排除表 | 2026-11-15 |
| T3 范围：`npx vitest run src/main/memory`，设置了 `FIREFLY_TEST_BASH` 和 `FIREFLY_HISTORY_PRESENCE_TEST_HELPER` | 143 个文件：142 通过、1 跳过；2679 项：2674 通过、5 跳过（非 Windows 平台用例）；10 个提交逐个单独检出复核，结果相同 | 2026-11-14 |
| T3：`npm run test:memory-history-zero-write`（需要 `FF_HISTORY_TEST_ROOT`、`FF_HISTORY_HELPER`、`FF_HISTORY_RELEASE_HELPER`） | 合入 dev 后 12 项全部通过（T2 基点上 `whole valid capture/query` 失败，见第 6 节） | 2026-11-14 |
| T3：`git grep -n "toThrow()"` 8 个目标子目录 | 只剩排除表里的 `.not.toThrow()` 与 `storage-safety` 3 处 | 2026-11-14 |

## 6. 偏离计划

- T1.2 的 `write_file` 越界：审查报告建议断言 `permission_denied`，实际是相对路径先被路径形状检查拒绝（`E_PATH_NOT_ABSOLUTE`）。按产品的真实行为断言。
- 有 5 条没做反向验证，原因已写在表里：错误来自测试替身、平台行为，或者需要大改实现才能改坏。
- 工作区边界测试需要 Windows helper：本工作区复制了 `firefly-docs-eng` 构建的 `native/target/release/*.exe`，两边的 native 源码一致。
- T2：`toThrow("码")` 是子串匹配，产品把码改成带后缀的更长字符串时断言仍会通过；这里沿用 T1 的写法，没有改成精确匹配。
- T2：计划要求 `response-history-union` 补“没有生成响应、没有写入”。这个 fixture 里响应校验是纯读取，没有“生成响应”的可观察接口，所以只补了“记录库逐字节不变”（`denies()`）。`f.writes` 计的是命令条数，包含只读命令，不能当写入信号。
- T2：`canonical-summary` 里计划写的 `f.summaries()` 不存在，改为直接读 SQLite 的摘要记录数（`summaryCount()`）。
- T2：没做反向验证的项：`phase3-review-regressions.test.ts:18` 的 4001 字符断言（要改产品的长度处理，没找到单一可改的点）；`summaryCount()` 与 `denies()` 的“不变”断言（需要让产品在拒绝路径写入，改动过大）；`SUMMARY_INJECTED_FAULT`、`TypeError` 两处（来自测试替身 / 引擎）。`summaryCount()` 用首个用例提交后数量为 1 做了对照，`denies()` 断言了拒绝前记录非空。
- T2：`response-history-union` 里 `MEMORY_CONTEXT_RESPONSE_PROGRESS_DENIED` 在探测输出里被截断，已用测试通过确认完整码。
- T3：`native-history-zero-write.acceptance.ts` 用 `npm run test:memory-history-zero-write` 单独跑；`84d1d96` 起 CI 也会跑它。
- T3：零写入验收里 `whole valid capture/query` 一条在 T2 基点上失败：夹具直接写对话记录、没有登记用户来源，结果是 `coverage-insufficient`（`MEMORY_HISTORY_ORIGIN_UNPROVEN`）。dev 上的 `84d1d96` 已经按 `native-history-provider.test.ts` 的 `bindUsers()` 写法修好；T2 是在它之前分出来的，所以本分支合入 dev 后采用该修复，12 项全部通过。
- T3：不带原生辅助程序时，`native-history-presence-process.test.ts` 的 5 项会失败；设置 `FIREFLY_HISTORY_PRESENCE_TEST_HELPER` 指向构建好的 `firefly-history-presence.exe` 后通过。这是环境要求，与本次改动无关。
