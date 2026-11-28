# `electron-builder-config.test.mjs` 主进程分层后仍断言旧音乐脚本路径（已修复）

状态：已修复（PR #62 / `ecdd9d8` 与 PR #63 / `d2d1184`）
日期：2026-11-16

## 现象

主进程七层分层合入后，执行 Node 测试套件 `node --test "scripts/**/*.test.mjs"` 或单独运行 `node --test scripts/packaging/electron-builder-config.test.mjs` 时，`electron-builder-config.test.mjs` 第 100 行附近失败退出 1（17 通过、1 失败）。

## 触发条件或复现步骤

在 PR `#57`–`#59` 合入之后、PR `#62`/`#63` 合入之前的提交基线上运行 `node --test scripts/packaging/electron-builder-config.test.mjs`。

## 影响范围

- **受影响检查**：Node 脚本打包配置回归测试（当时尚未接入 `.github/workflows/test.yml` 的 `Run Node script tests`）。

## 根因

1. 主进程七层分层（PR `#57` `2dab331`）将音乐脚本目录迁移到了 `src/main/platform/music/scripts/qqmusic_gsmtc.ps1`，`electron-builder.yml` 也已更新为新路径。
2. 但 `scripts/packaging/electron-builder-config.test.mjs` 属于 `node --test` 独立脚本套件、不在默认 `npm test`（Vitest）集合内，因此分层重构后该测试仍硬编码断言旧路径 `src/main/music/scripts/qqmusic_gsmtc.ps1`，在 PR `#62`/`#63` 同步施工准备把脚本测试接入 CI 时才暴露出来（详见 `data-directory-1-2-0-progress.md` §5、`docs-and-engineering-progress.md` §偏离计划 & §收尾复验）。

## 当前状态

- **已修复**：PR `#62`（`ecdd9d8`）与 PR `#63`（`d2d1184`）已将该断言更新为 `src/main/platform/music/scripts/qqmusic_gsmtc.ps1`；收尾复验时 `electron-builder-config.test.mjs` 全部通过。

## 相关文件

- `scripts/packaging/electron-builder-config.test.mjs`
- `electron-builder.yml`
- `src/main/platform/music/scripts/qqmusic_gsmtc.ps1`
- `docs/superpowers/plans/data-directory-1-2-0-progress.md`（§5 偏离计划）
- `docs/superpowers/plans/docs-and-engineering-progress.md`（§偏离计划、§收尾复验）
- 修复提交：PR `#62`（`ecdd9d8`）、PR `#63`（`d2d1184`）
