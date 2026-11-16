# `native-history-zero-write` 验收 `whole valid capture/query` 曾报 `coverage-insufficient`（已修复）

状态：已修复（PR #63 / `d2d1184`）

## 现象

在将原生历史零写入独立验收脚本接入 CI 并补充有效捕获前提时，`npm run test:memory-history-zero-write` 执行 12 项用例中稳定出现 11 通过、1 失败：唯一失败用例 `src/main/memory/sources/native-history-zero-write.acceptance.ts` 的 `whole valid capture/query` 预期返回 `captured`，实际却返回 `coverage-insufficient`（诊断原因 `partial-source`，诊断码 `MEMORY_HISTORY_ORIGIN_UNPROVEN`）。

## 触发条件或复现步骤

在 PR `#63` 合并前，按 `docs/engineering/test-coverage-map.md` 配置好 `FF_HISTORY_TEST_ROOT`、`TEMP`/`TMP`、debug `firefly-history-read.exe` 与 release 对照 helper 后运行 `npm run test:memory-history-zero-write`。

## 影响范围

- **受影响范围**：原生历史零写入独立验收测试（`scripts/testing/vitest.memory-history-zero-write.config.ts`）。产品历史来源证明契约本身行为正常。

## 根因

`docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md` §收尾复验（及 `2026-11-15-test-assertion-hardening-progress.md` §6 T3）定位：

1. `history-repository.ts` 的 `projectNative` 在 `originStates` 非全部 `valid` 时返回 `partial` 且不产出生效文档，`native-history-provider.ts` 据此判定为 `coverage-insufficient`（`MEMORY_HISTORY_ORIGIN_UNPROVEN`）。
2. `native-history-zero-write.acceptance.ts` 的夹具仅通过 `ConversationTranscriptStore` 写入对话记录，漏掉了像 `native-history-provider.test.ts` 中 `bindUsers()` 那样调用 `historyUserOrigin` 登记用户消息来源的步骤，导致来源证明缺失——属于测试夹具缺口，而非产品代码故障。

## 当前状态

- **已修复**：PR `#63`（`d2d1184`）已在验收夹具 `checkpoint` 之后按真实流程补全 `historyUserOrigin` 登记（未放宽原断言），重跑 `npm run test:memory-history-zero-write` 12 项全部通过；合入 `dev` 后在测试断言整改 T3 中同样 12 项通过。

## 相关文件

- `src/main/memory/sources/native-history-zero-write.acceptance.ts`
- `src/main/memory/history/history-repository.ts`
- `src/main/memory/history/native-history-provider.ts`
- `src/main/memory/history/native-history-provider.test.ts`
- `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`（§新发现的未完成项与偏离计划、§收尾复验）
- `docs/superpowers/plans/2026-11-15-test-assertion-hardening-progress.md`（§5、§6 T3）
- 修复提交：PR `#63`（`d2d1184`）
