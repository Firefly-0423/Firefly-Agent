# 测试断言整改施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-test-assertion-hardening.md](./2026-11-15-test-assertion-hardening.md)

## 1. 当前状态

- 分支：`feat/test-assertions-t1`（基于 `docs/test-assertion-plan`）
- 进行到：施工包 T1 完成

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

## 3. 排除（复核后不改）

| 位置 | 原因 |
|---|---|
| `src/main/features/channels/adapters/qqbot/qqbot-api-client.test.ts:177` | 紧接着已断言请求地址、方法和请求体 |
| `src/main/agent/tools/workspace-boundary.test.ts:185` | 已断言 `category: "permission_denied"` |
| `src/main/memory/core/storage-safety.test.ts:83/88/92` | 断言的是测试辅助函数本身抛出的断言失败，没有稳定码可言 |

## 4. 缺稳定错误码

| 位置 | 产品抛出的错误 | 现在改为断言什么 |
|---|---|---|
| `src/main/agent/mcp/mcp-adapter.ts` 连接失败分支 | 原样抛出底层错误，消息里可能带有连接信息（不写日志；上层 `mcp-manager` 会分类成固定原因） | 断言是同一个错误对象，并断言没有任何注册和残留状态 |

## 5. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| T1 范围：`npm test -- src/main/agent/loop src/main/agent/mcp src/main/agent/tools src/main/memory/core src/main/memory/history src/main/memory/policy`，设置了 `FIREFLY_REQUIRE_WORKSPACE_HELPER=1` 和 `FIREFLY_TEST_BASH` | 174 个文件：173 通过、1 跳过；3049 项：3043 通过、6 跳过 | 2026-11-15 |
| `tsc -p tsconfig.main.json --noEmit` | 通过 | 2026-11-15 |

## 6. 偏离计划

- T1.2 的 `write_file` 越界：审查报告建议断言 `permission_denied`，实际是相对路径先被路径形状检查拒绝（`E_PATH_NOT_ABSOLUTE`）。按产品的真实行为断言。
- 有 5 条没做反向验证，原因已写在表里：错误来自测试替身、平台行为，或者需要大改实现才能改坏。
- 工作区边界测试需要 Windows helper：本工作区复制了 `firefly-docs-eng` 构建的 `native/target/release/*.exe`，两边的 native 源码一致。
