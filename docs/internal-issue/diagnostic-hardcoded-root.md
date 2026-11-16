# 一次性诊断入口硬编码历史本机输出根目录

状态：待负责人决定（打包版禁用已在 PR #70 落地，环境变量覆盖与错误输出已在 PR #84 缓解；硬编码默认路径 `DEFAULT_BASE` 与 `ADMISSION_ROOT` 去留待定）
日期：2026-11-16

## 现象

`src/main/features/diagnostics/memory-online-once/` 与 `src/main/features/diagnostics/memory-openrouter-once/` 两套一次性诊断入口内均将默认基础目录 `DEFAULT_BASE` 与准入目录 `ADMISSION_ROOT` 硬编码为本机早期实验目录（`E:\Codex\2026-10-01\task\...`）。在 PR `#84` 之前，若未显式匹配该历史目录且在默认输出根外运行，会直接抛出 `DIAGNOSTIC_ROOT_REFUSED` 且被 `fail()` 中的空 `catch` 静默吞掉，导致进程无输出退出 1。

## 触发条件或复现步骤

1. 检查两套诊断入口文件：
   - `src/main/features/diagnostics/memory-online-once/diagnostic-main.ts`（`DEFAULT_BASE = "E:\\Codex\\2026-10-01\\task\\firefly-memory-next-stage\\output\\memory-online-startup"`）与 `runner.ts`（`ADMISSION_ROOT = "E:\\Codex\\2026-10-01\\task\\memory-online-once-admission-55df896"`）；
   - `src/main/features/diagnostics/memory-openrouter-once/diagnostic-main.ts`（`DEFAULT_BASE = "E:/Codex/2026-10-01/task/firefly-memory-next-stage/output/openrouter-usd1"`）与 `runner.ts`（`ADMISSION_ROOT = "E:\\Codex\\2026-10-01\\task\\memory-openrouter-usd1-admission-20261002"`）。
2. 在未设置 `FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_BASE` / `FIREFLY_OPENROUTER_DIAGNOSTIC_BASE` 的环境传入仓库内的独立临时路径（如 `FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_ROOT`）执行诊断模式，由于 `within(base, resolved)` 判定输出不在 `DEFAULT_BASE` 之下，直接拒绝启动。

## 影响范围

- **受影响组件**：仅开发版启动诊断入口（`memory-online-once`、`memory-openrouter-once`）及对应验证脚本（`scripts/verify/memory-online-startup` 等）。
- **非打包影响**：PR `#70`（`2a5c383`）已通过 `diagnosticSwitchesAllowed(!app.isPackaged)` 确保安装版完全忽略诊断启动参数并按正常应用启动，不暴露给普通最终用户。

## 根因

早期阶段性联调脚本将试验性输出根与准入凭证目录写死在源码常量中，且 `diagnostic-main.ts` 的 `fail()` 回调曾吞掉异常未输出诊断码（`2026-11-15-coupling-audit-followup-progress.md` §2 R6 代码审查后修复）。

## 当前状态

- **部分缓解**：
  - PR `#70`（`2a5c383`）：打包版禁用所有一次性诊断参数。
  - PR `#84`（`1d739c0`）：新增 `FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_BASE` 与 `FIREFLY_OPENROUTER_DIAGNOSTIC_BASE` 环境变量覆盖，并在失败时输出错误码到 `stderr`，使 `memory-online-startup`（12 项）与 `memory-openrouter-once`（25 项）验证脚本得以通过。
- **待负责人决定**：源码中的历史本机路径默认值（`DEFAULT_BASE` 与 `ADMISSION_ROOT`）以及这两套诊断代码后续是否删除或改为仓库隔离路径，尚未最终清理（`coupling-audit-followup-progress.md` §4）。

## 相关文件

- `docs/superpowers/plans/2026-11-15-coupling-audit-followup-progress.md`（§2 R6、§4 偏离计划）
- `src/main/features/diagnostics/memory-online-once/diagnostic-main.ts`
- `src/main/features/diagnostics/memory-online-once/runner.ts`
- `src/main/features/diagnostics/memory-openrouter-once/diagnostic-main.ts`
- `src/main/features/diagnostics/memory-openrouter-once/runner.ts`
- `src/main/base/identity/startup-entry.ts`
- 提交与 PR：PR `#70`（`2a5c383`）、PR `#84`（`1d739c0`）
