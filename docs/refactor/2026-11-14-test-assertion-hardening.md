# Agent / Memory / Channels 测试断言加固

状态：T1–T5 已合并完成；T6（真实等待改为假定时器）尚未施工合并  
日期：2026-11-14（首个计划合并 PR `#64` 合并日；施工计划与进度文件按 `2026-11-15` 命名）

## 为什么做

2026-11-14 对 `src/main/agent`、`src/main/memory` 与 `src/main/features/channels` 共 382 个测试文件的断言质量审查发现（`docs/superpowers/plans/2026-11-15-test-assertion-hardening.md`）：大量测试存在违反 `AGENTS.md`「测试断言写法」12 条规则的问题——包括 204 处不带错误码的裸 `toThrow()` / `rejects.toThrow()`（agent 37、memory 161、channels 6）、22 处仅断言不报错或 `undefined`/已定义的弱断言、缺少拒绝路径的“不写盘/不发请求”负向副作用断言，以及部分真实定时器等待。

整改要求**只改测试、不改产品代码与错误码定义**，且对每一条重构后的断言做**反向验证**（临时改坏对应产品实现，确认测试先失败再还原）。

## 改了什么（前后结构对照）

| 施工包 / 维度 | 整改前 | 整改后 |
| --- | --- | --- |
| **共享精确匹配辅助**（PR `#83`） | 初期对 `MEMORY_*` 码使用字符串子串匹配 `toThrow("码")`，若码被加上额外后缀仍能通过 | 新增 `src/shared/testing/error-code.test-support.ts` 的 `exactly(code)`（精确正则 `^码$`），在 T2–T5 与回补的 T1 全面改为精确匹配 |
| **T1：安全与权限拒绝路径**（PR `#65`、`#83`） | `tool-protocol`、`mcp-adapter-security`、`mcp-manager-enabled`、`sync-mcp-builtin`、`workspace-boundary`、`agent-loop-cancel`、`payload-codec`、`history-migration`、`natural-job-repository` 存在裸报错或缺少副作用断言 | 断言 `ToolCallArgumentsError`、精确产品错误码（`ATOMIC_JSON_WRITE_FAILED`、`E_PATH_NOT_ABSOLUTE`、`MEMORY_AUTH_FAILED`、`MEMORY_INPUT_INVALID`、`MEMORY_DATA_INVALID` 等）、同一底层错误对象引用，以及未写入/未调用 MCP `tools/call` 或 `dispatch` |
| **T2：`memory/context` 断言**（PR `#72`） | `main-memory-contracts`、`main-responses-binding`、`main-context`、`canonical-summary`、`response-history-union` 等大量裸 `toThrow()`，且缺少拒绝前后数据库全表不变检查 | 37 个 `MEMORY_*` 错误码全面改为表驱动精确断言；`canonical-summary` 新增 `summaryCount()` SQLite 摘要行数对照；`response-history-union` 新增 `denies()` 全行比较 `context_records` 与 `history_records` 拒绝前后逐字节一致 |
| **T3：`memory` 其余子目录**（PR `#79`） | `history`（32 处）、`policy`（21 处）、`core`（13 处）、`sources`（6 处）、`legacy`、`database`、`shadow`、`recall` 的裸 `toThrow()` | 8 个目标子目录共 346 处断言改为 `exactly()` / 精确消息对比（legacy 含用户提示分支）、表驱动与持久化未变化断言；`history-query-quality.test.ts` 按真实分词上限断言 `65536+128` 拒绝 |
| **T4：`features/channels` 断言**（PR `#80`） | `qqbot-api-client`、`message-log`、`history-log`、`dispatcher`、`audio-duration` 存在 `.not.toThrow()` 或泛断言 | `channels` 内裸 `toThrow()` 清零（`git grep` 为 0）；`qqbot` 断言真实两次 fetch 与 URL/headers/msg_id；`message-log`/`history-log`/`dispatcher` 验证文件未改写及构造期不读盘；`audio-duration` 取 500ms 边界两侧精准断言 |
| **T5：`agent` 断言**（PR `#88`） | `src/main/agent` 下 15 个文件剩余的裸 `toThrow()` 与弱断言 | 完成 T5.1–T5.4 覆盖（`loop`、`memory-runtime`、`runtime`、`sandbox`、`services/llm`、`tools` 共 15 个测试文件），将 180 处改为 `exactly()`、3 处 `PENDING_ADJUST_COMMIT_FAILED` 锚定前缀、及 Node `EEXIST` 按 `code` 字段断言 |

## 怎么验证的

1. **反向验证机制**（`2026-11-15-test-assertion-hardening-progress.md` §2）：每类产品错误码和校验逻辑均采用“临时改坏产品源码（改坏错误码字符串、删掉写入检查或跳过校验）→ 跑对应套件确认测试失败 → `git checkout` 还原产品文件”进行证实（如 T2 37 个 `MEMORY_*` 码逐一改坏均导致对应测试失败）。
2. **分包全过记录**：
   - T1：174 文件 3049 项（3043 通过、6 跳过）及 `tsc -p tsconfig.main.json --noEmit` 通过；
   - T2：`src/main/memory/context` 33 文件 624 项通过；`toThrow()` 扫描仅剩已审核的 `.not.toThrow()` 排除项；
   - T3：`src/main/memory` 143 文件 2679 项（2674 通过、5 非 Windows 平台跳过）逐提交检出通过；`test:memory-history-zero-write` 12 项通过；
   - T4：`src/main/features/channels` 54 文件 429 项全通过，`git grep "toThrow()"` 为 0；
   - T5：`src/main/agent` 2649 项通过、2 项跳过（15 个提交逐个检出复核通过）。

## 涉及的 PR

- **PR `#64`**（`27cbfca`，2026-11-14）：`docs/test-assertion-plan`（计划与进度立档）。
- **PR `#65`**（`ca6f477`，2026-11-14）：`feat/test-assertions-t1`（T1 安全与权限拒绝路径）。
- **PR `#72`**（`e2eeb53`，2026-11-15）：`feat/test-assertions-t2`（T2 `memory/context` + `exactly()` 引入）。
- **PR `#79`**（`8d5bf87`，2026-11-15）：`feat/test-assertions-t3`（T3 `memory` 其余 8 个子目录）。
- **PR `#80`**（`60ea972`，2026-11-15）：`feat/test-assertions-t4`（T4 `features/channels`）。
- **PR `#83`**（`31dbc28`，2026-11-15）：`feat/test-assertions-t1-exact`（回补 T1 测试中的 7 处 `exactly()` 精确匹配）。
- **PR `#88`**（`a760726`，2026-11-15）：`feat/test-assertions-t5`（T5 `src/main/agent` 15 个文件）。

## 遗留事项

1. **T6（真实等待改为假定时器）尚未实施**（`2026-11-15-test-assertion-hardening.md` §现状与进度文档停于 T5）：原审查列出的真实定时器等待（9 处确认、12 处待复核）尚未开启对应 PR；`test-assertion-hardening-progress.md` 也未合入 T5 的详细更新段（仅合入进度表改动一行）。
2. **缺少稳定产品错误码的既有分支**（[missing-product-error-codes.md](../internal-issue/2026-11-16-missing-product-error-codes.md)）：已登记 8 类缺少产品码的分支（含 `mcp-adapter.ts`），待负责人另立计划裁定。
3. **旧权限档位用例暂未动**（计划文档 §不改的东西）：约 95 处涉及 `scoped` / `project-read-only` 的测试随 1.2.0 插件 SDK 规格第 3 阶段删除代码时一并迁移。
