# `memory-core/probe-root` 验证测试曾硬编码外部工作区路径（已修复）

状态：已修复（PR #63 / `d2d1184`）
日期：2026-11-16

## 现象

在任何非原工作目录或 CI 环境运行全量 Node 脚本测试 `node --test "scripts/**/*.test.mjs"` 时，`scripts/verify/memory-core/probe-root.test.mjs`（第 8–9 行）均直接失败；同时 `scripts/verify/memory-core/probe-root.ts` 的 `PROBE_CWD` 边界也固定在某个历史外部工作区目录。

## 触发条件或复现步骤

在 PR `#63` 合入之前的分支（如 PR `#62` 施工期）于任意标准仓库检出目录运行 `node --test scripts/verify/memory-core/probe-root.test.mjs` 或 `node --test "scripts/**/*.test.mjs"`。

## 影响范围

- **受影响范围**：`scripts/verify/memory-core/` 相关 Node 脚本测试与探测脚本；此前因 `scripts/**/*.test.mjs` 未接入 CI，在主分支上长期未被发现。

## 根因

`probe-root.test.mjs` 与 `probe-root.ts` 早期将允许的工作目录硬编码为本机一次性任务输出目录的绝对路径（详见 `2026-11-13-data-directory-1-2-0-progress.md` §5、`2026-11-12-docs-and-engineering-progress.md` §新发现的未完成项与偏离计划），未基于当前仓库根目录动态识别授权工作区边界。

## 当前状态

- **已修复**：PR `#63`（`d2d1184`）已改造 `scripts/verify/memory-core/probe-root.ts`，导出 `isProbeWorkspace(cwd)`（验证 `cwd` 为包含自身文件且 `package.json` 为 `firefly-agent` 的当前仓库根目录）与 `assertProbeRoot`；相关测试与驱动脚本改为按 `import.meta.dirname` 推导仓库根，继续保持对盘符越界、外部 junction、同级目录和相对路径的拒绝。`node --test scripts/verify/memory-core/probe-root.test.mjs` 6 项全部通过。

## 相关文件

- `scripts/verify/memory-core/probe-root.ts`
- `scripts/verify/memory-core/probe-root.test.mjs`
- `docs/superpowers/plans/2026-11-13-data-directory-1-2-0-progress.md`（§5 偏离计划）
- `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`（§收尾复验）
- 修复提交：PR `#63`（`d2d1184`）
