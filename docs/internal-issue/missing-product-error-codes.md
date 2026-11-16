# 部分错误与拒绝路径缺少稳定产品错误码

状态：待负责人决定
日期：2026-11-16

## 现象

在依据 `AGENTS.md`「测试断言写法」第 3 条（错误分支须断言稳定错误码/错误类型，避免脆弱匹配任意英文文本）对 `src/main/agent`、`src/main/memory` 与 `src/main/features/channels` 进行断言加固时，核查发现一批真实报错或拒绝分支未抛出产品自定义错误码，例如：

- `src/main/agent/mcp/mcp-adapter.ts` 的连接失败分支直接将底层网络/子进程原始错误对象原样向外抛出（错误消息中可能夹带底层连接信息）；
- `src/main/memory/legacy/memory-schemas.ts` 仅抛出纯文本消息而无稳定错误码；
- 多处冻结对象改写、只读校验、函数载荷克隆、SQLite 约束及 Windows `fs.renameSync` 失败直接透出引擎 `TypeError`、V8 `DataCloneError`、`SqliteError` 或操作系统 errno（`EPERM`）。

## 触发条件或复现步骤

在执行 `docs/superpowers/plans/2026-11-15-test-assertion-hardening.md` 并对既有 `toThrow()` 用例逐条排查真实产品返回时触发上述发现，具体清单已登记在 `docs/superpowers/plans/2026-11-15-test-assertion-hardening-progress.md` §4「缺稳定错误码」。

## 影响范围

- **受影响组件**：`src/main/agent/mcp/mcp-adapter.ts`、`src/main/memory/legacy/memory-schemas.ts`、以及上述进度文档 §4 所列的 `main-memory-contracts` / `history` / `core` / `recall` / `database` 测试覆盖边界。
- **下游影响**：外部调用方或单元测试无法用统一的 `error.code` / 前缀码精准区分原因（`mcp-adapter` 须由上层 `mcp-manager` 二次分类，底层连接失败分支仍直出原始异常）；若依赖纯文本断言，后续微调提示文案即可造成误断或掩盖脱敏缺口。

## 根因

`2026-11-15-test-assertion-hardening.md` 规定“只改测试、不改产品代码与错误码定义”，因此整改过程中不得顺手补齐缺失的产品错误码；遇无产品码路径时，仅按真实报错对象/消息、`TypeError` / `DataCloneError` / `EPERM` 或副作用未发生做断言，并将其登记为遗留清单。

## 当前状态

- **待负责人决定**：已在 `docs/superpowers/plans/2026-11-15-test-assertion-hardening-progress.md` §4 完整登记 8 类路径，是否需要为其中的产品分支（特别是 `mcp-adapter.ts` 连接失败、`memory-schemas`）补充稳定产品错误码，待负责人评审决定后另立开发任务。

## 相关文件

- `docs/superpowers/plans/2026-11-15-test-assertion-hardening-progress.md`（§4 缺稳定错误码）
- `docs/superpowers/plans/2026-11-15-test-assertion-hardening.md`
- `src/main/agent/mcp/mcp-adapter.ts`
- `src/main/memory/legacy/memory-schemas.ts`
- `src/main/memory/context/main-memory-contracts.ts`
