# 测试断言整改施工计划

状态：已确认，施工中
来源：2026-11-14 对 `src/main/agent`、`src/main/memory`、`src/main/features/channels` 共 382 个测试文件的断言审查（Gemini 静态审查，克宝抽查复核）。行号以 `feat/docs-eng` 的 `84d1d96`（PR #63）为准，开工前在当前分支重新定位。

**目标：** 让这三个模块的测试符合 `AGENTS.md`「测试断言写法」12 条规则，重点补上：错误码断言（规则 3）、拒绝路径的副作用断言（规则 4）、"只断言不报错"的行为断言（规则 2）、真实等待改为假定时器（规则 6）。

**做法：** 只改测试，不改产品代码。每改一条断言都做一次反向验证：临时把对应实现改坏（删掉校验、换掉错误码、去掉写入），确认新断言失败，再还原。这样能证明断言确实守住了行为，而不只是"能通过"。

**不改的东西：**
- 产品代码、错误码定义、超时数值都不动。
- 旧权限档位 `scoped` / `project-read-only` 在测试中约 95 处，不在本计划内处理。删除这两个档位是 SDK 规格（`docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md`）第 3 阶段的任务，测试随代码一起改。
- 不为了凑规则改写已经合规的测试（见"已排除的条目"）。

## 现状

- 不带错误码的 `toThrow()` / `rejects.toThrow()`：重新扫描为 204 处，分布是 agent 37、memory 161、channels 6。审查报告记的是 168 处，统计口径不同，以开工时重新扫描为准。
  - memory 161 处的子目录分布：context 77、history 32、policy 21、core 13、sources 6、legacy 4、database 4、shadow 2、recall 2。
- 审查报告列出的问题：
  - A 类（只断言不报错、返回 undefined 或已定义）22 条；
  - C 类（只断言被调用）4 条；
  - D 类（断言实现细节）3 条；
  - E 类（真实等待）确认 9 处，另有 12 处待复核。
- 快照代替行为断言：0 处。静默 `return` 冒充通过：0 处。

## 已排除的条目

抽查复核后确认是误报或已合规的条目，不改：

- **A6** `qqbot-api-client.test.ts:177`：`resolves.toBeUndefined()` 之后紧接着断言了请求地址、方法和请求体。
- **B10 的第二行** `workspace-boundary.test.ts:185`：已断言 `category: "permission_denied"`。只改第 184 行的 `write_file`。
- `storage-safety.test.ts:83/88/92`：断言的对象是测试辅助函数本身抛出的断言失败，没有稳定码可言。
- 审查报告第 6 节列出的合规命中：类型收窄的 `return`、替身内部的 `return`、`not.toThrow()` 作探针、契约本身就是"什么都不做"的测试、`setTimeout(resolve, 0)` 清队列。

## 全局约束

- 每个施工包开工时重新扫描、逐条读上下文，误报记进进度文档的"排除"表，不改。
- **错误码以产品实际抛出的为准。** 产品在这条路径上没有稳定码时：
  - 断言错误类型，或断言稳定的 `category` / `reason` 字段；
  - 把这条记进进度文档的"缺稳定错误码"清单；
  - 本计划不给产品加错误码。
- 拒绝路径的断言要补"不该发生的事"：没有写入、没有派发、没有调用、敏感内容没有出现。
- 时间相关测试用 `vi.useFakeTimers()`，在 `afterEach` 里恢复真实定时器。测临界点和两侧，只测阈值本身（不改阈值）。
- 每条改动都要做反向验证，不能只看改完能通过。在提交说明或进度文档里写明：改坏了哪一处实现，新断言因此失败了。
- 一个施工包一个 PR。改动只在测试文件里；测试辅助函数可以新增，放在同一目录。

## 施工包

### 施工包 T1：安全与权限的拒绝路径

依赖：无（最先做）

- [ ] T1.1 工具参数与 MCP
  - 范围：
    - `src/main/agent/loop/tool-protocol.test.ts:130, 165`（B1）
    - `src/main/agent/mcp/mcp-adapter-security.test.ts:63`（B9）
    - `src/main/agent/mcp/mcp-manager-enabled.test.ts:74`
    - `src/main/agent/mcp/sync-mcp-builtin.test.ts:50-51`（C1）
  - 改法：断言稳定错误码。B9 再断言没有发出 `tools/call`。C1 断言 `console.error` 只调用 1 次、带稳定前缀，日志里没有 token 或环境变量值，且 `removeMcpServer` 没被调用。
- [ ] T1.2 工作区越界
  - 范围：`src/main/agent/tools/workspace-boundary.test.ts:184`（B10，只改 `write_file` 这一行）、`src/main/agent/tools/workspace-handle.integration.test.ts:33`
  - 改法：断言 `permission_denied`，并用真实文件检查越界目标在磁盘上没有被创建或修改（规则 9）。
- [ ] T1.3 晚到的审批
  - 范围：`src/main/agent/loop/agent-loop-cancel.test.ts:111-124`（C3）
  - 改法：在 `permission.release(true)` 之后再断言一次：`actual` 没被调用，`dispatch` 次数不变，事件列表里没有新增 tool 事件。
- [ ] T1.4 记忆的完整性与跨主体访问
  - 范围：
    - `src/main/memory/core/payload-codec.test.ts:18`（B6）
    - `src/main/memory/history/history-migration.test.ts:22`（B7）
    - `src/main/memory/policy/natural-job-repository.test.ts:138`（B11）
  - 改法：断言完整性或拒绝错误码。B7 再断言 preview 没有写入迁移记录；B11 再断言结果里没有 actor-a 的数据（规则 10）。
- 验证：`npm test -- src/main/agent/loop src/main/agent/mcp src/main/agent/tools src/main/memory/core src/main/memory/history src/main/memory/policy`
- 验收：上面列出的每一条都做过反向验证，并有记录。

### 施工包 T2：memory/context 的错误码

依赖：T1（沿用 T1 定下的错误码断言写法）

- [ ] T2.1 合同与绑定
  - 范围：`main-memory-contracts.test.ts`、`main-responses-binding.test.ts:77`（B4，改为表驱动 `[输入, 期望码]`）、`main-context.test.ts`
- [ ] T2.2 摘要与响应历史
  - 范围：`canonical-summary.test.ts:65`（B3，表驱动，并断言 `f.summaries()` 数量没变）、`response-history-union.test.ts:37, 51, 55, 78`（B5，并断言没有生成响应、没有写入）、`bounded-admission.test.ts:43`
- [ ] T2.3 其余 context 测试
  - 范围：重新扫描 `src/main/memory/context` 中剩下不带码的 `toThrow()`，加上 `phase3-review-regressions.test.ts:18`（A13：断言组装结果里含有那条 4001 字符的用户消息，内容完整）。
- 说明：
  - 这一目录有 77 处，是最集中的地方；
  - 有 51 处同一行已经断言了副作用，只缺错误码，这些改动是机械的；
  - 一个 PR 改动过大时，可以按上面三个任务拆成三个 PR。
- 验证：`npm test -- src/main/memory/context`

### 施工包 T3：memory 的其余子目录

依赖：T1

- [ ] T3.1 history 与 sources
  - 范围：
    - `history-repository.test.ts:82, 206`（A11、A12：断言 `validate` 的返回结果）、`:227`（B8：改为 `it.each`，每组断言错误码）
    - `history-query-quality.test.ts:60`（A17：断言截断结果，补测 65535、65536、65537 三个点）
    - `native-history-transport.test.ts:44`（A18：断言挂起的请求以稳定码 reject，且之后不再写入）
    - history 与 sources 中剩下不带码的 `toThrow()`
- [ ] T3.2 legacy 压缩器
  - 范围：`memory-compressor.test.ts:235-241, 246-283, 362`（A2、A3、A4、C2、D3）
  - 改法：断言外部可观察的结果，即 `commit` 的参数、`appendReflectionLog`、L2 记录有没有变化；内部协作者"没被调用"最多保留一条，只用来证明"跳过时没有产生调用成本"。
- [ ] T3.3 policy、core、database、shadow、recall
  - 范围：`temporal-memory.test.ts:40`（B12），以及这几个目录中剩下不带码的 `toThrow()`。
- 验证：`npm test -- src/main/memory`

### 施工包 T4：channels

依赖：无（可以和 T2、T3 并行）

- [ ] T4.1 qqbot
  - 范围：`qqbot-api-client.test.ts:248-250`（A5：断言请求地址、`Authorization`、`msg_id`、`msg_seq`，以及 fetch 共调用 2 次）
- [ ] T4.2 日志
  - 范围：
    - `message-log.test.ts:121-122, 139`（A7、A8：断言 `getRecentLog()` 为 `[]`，并检查文件和目录的状态）
    - `history-log.test.ts:61-62`（A9：用 `toStrictEqual` 比较迁移前后，断言历史原样保留）
    - `dispatcher.test.ts:52-55`（D1：改为断言"构造时不读盘"这一可观察结果）
- [ ] T4.3 飞书音频时长
  - 范围：`audio-duration.test.ts:34-46`（A20–A22）
  - 改法：输入是固定的，直接断言精确毫秒数；在 500ms 下限的两侧补测。
- [ ] T4.4 channels 中剩下的 6 处不带码的 `toThrow()`
- 验证：`npm test -- src/main/features/channels`

### 施工包 T5：agent 的其余部分

依赖：T1

- [ ] T5.1 沙箱与工作区
  - 范围：
    - `sandbox-exec.test.ts:189`（A1：断言清理失败后可以重新初始化，不会留下半初始化的状态）
    - `workspace-boundary.unit.test.ts:55-56`（A14：断言返回的规范化路径，并补一条越界对照）
- [ ] T5.2 运行时
  - 范围：
    - `environment.test.ts:34`（A15：断言回退后的完整环境对象）
    - `lifecycle-publisher.test.ts:140`（A16：断言没有重复发布，其他订阅者不受影响）
    - `agent-runtime.test.ts:59-62`（C4：断言写入的终态）
    - `pending-adjustment.test.ts:64`
- [ ] T5.3 memory-runtime
  - 范围：
    - `default-run-capture.test.ts:177`（A10：补一条对照，来源变化后抛出稳定码）
    - `main-default-memory.test.ts:687`（A19：断言没有 grant 类命令）
    - `conversation-transcript-adapter.test.ts` 中不带码的 `toThrow()`（B2 等）
    - `main-memory-runtime.test.ts:140`、`task-source-provider.test.ts:46`
- [ ] T5.4 其余
  - 范围：
    - `llm-client.test.ts:143-147`（D2：只匹配计时日志的前缀）
    - `document-pdf-output.test.ts:93, 137, 160`
    - `transcript-sink.test.ts:107`
    - agent 中剩下不带码的 `toThrow()`
- 验证：`npm test -- src/main/agent`

### 施工包 T6：真实等待改假定时器

依赖：T1–T5（这个包最容易引入不稳定，放在最后）

- [ ] T6.1 已确认的 9 处
  - 范围：
    - `agent-loop-deadline.test.ts:182, 199`（E1、E2）
    - `memory-settings-ipc.test.ts:134, 187`（E3、E4）
    - `main-default-memory.test.ts:1035, 1062, 1071, 1126`（E5–E8）
    - `qqbot-adapter.test.ts:128`（E9）
  - 改法：有完成信号的（`idle()`、drain）等待完成信号；涉及时间窗口的用假定时器测临界点两侧。
- [ ] T6.2 待复核的 12 处
  - 范围：
    - `agent-loop-cancel.test.ts:65, 85, 105`
    - `tool-call-scheduler.test.ts:198, 216`
    - `main-default-memory.test.ts:311, 816, 918`
    - `shadow-service.test.ts:153, 201`
    - `document-pdf-runtime.test.ts:62`
    - `persistent-agent-runtime.test.ts`
  - 改法：逐条判断。只是为了让异步链路走完、又有可等待的信号的，改为等待信号；没有信号也不涉及时间窗口的，保留原样并记进"排除"表。
- 验证：每个改动的文件连续跑 20 次都通过：`npx vitest run <文件> --repeat 20`（命令以当前 vitest 版本支持的写法为准）。再跑一次全量 `npm test`。

## 验收清单

- [ ] T1–T6 各自合并，验证通过
- [ ] 三个模块中不带码的 `toThrow()` 只剩"排除"表和"缺稳定错误码"清单里的条目
- [ ] 每一条改动都有反向验证记录
- [ ] 全量 `npm test` 和三端类型检查通过

## 回滚

每个施工包只改测试，revert 对应 PR 即可，不影响产品行为。

## 负责人决定（hotaru，2026-11-15）

1. 产品没有稳定错误码时只记清单，本计划不给产品加错误码；补错误码另立计划单独审。
2. T6 的稳定性标准：每个改动的文件连续跑 20 次都通过。
