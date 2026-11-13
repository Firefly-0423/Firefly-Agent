# 1.2.0 正式数据目录施工进度

状态：施工中（施工包 A 已完成并通过全量测试；等打包版真机验证）
施工计划：[2026-11-13-data-directory-1-2-0.md](./2026-11-13-data-directory-1-2-0.md)

## 1. 当前状态

- 分支：`feat/data-dir`（基于 `docs/plans-new-paths` 的 `74d4d4e`）
- 进行到：施工包 A 的 A1–A3 完成
- 工作区：已提交

## 2. 已完成项

| 任务 | 改动 | 验证 |
|---|---|---|
| A1 目录名常量 | 新增 `src/main/base/identity/data-directory.ts`（`FIREFLY_DATA_DIRECTORY = "Firefly-1.2.0"`）；`resolveRuntimeProfile` 的正式分支与 `app-identity.ts` 的 `FIREFLY_USER_DATA_DIRECTORY` 都用它。测试先改为期望 `Firefly-1.2.0` 并断言正式档案的三个路径都不在 `%APPDATA%\Firefly` 之内，确认失败后再改实现 | `npm test -- src/main/base/identity src/main/app/identity-preflight.test.ts`：11 个文件、72 项通过 |
| A2 安装器同一目录 | `build/installer.nsh` 的开机自启选项写到 `$APPDATA\Firefly-1.2.0\installer-options.json`；打包配置测试从 `data-directory.ts` 读出目录名，比对安装器脚本，并断言不再写 `$APPDATA\Firefly`（先失败后通过） | `node --test scripts/packaging/electron-builder-config.test.mjs`：17 项通过 |
| A3 验证脚本与文档 | `scripts/verify/memory-online-startup` 的 `drive.mjs`、`entry.cjs` 改用新目录；README、README.en、DEVELOPMENT 的数据位置改为 `%APPDATA%\Firefly-1.2.0`，说明 1.1.x 目录不读、不删 | `git grep` 确认除“不读取旧目录”的说明和反向断言外，不再把 `%APPDATA%\Firefly` 当作当前数据目录 |

## 3. 未完成项

| 项 | 说明 |
|---|---|
| 打包版真机验证 | 全新安装后数据在 `%APPDATA%\Firefly-1.2.0`；已有 `%APPDATA%\Firefly` 时旧目录不变；勾选开机自启后首次启动读到该选项。下次打包时做 |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| 身份与启动相关测试 | 72 项通过 | 2026-11-13 |
| 打包配置测试 | 17 项通过 | 2026-11-13 |
| main 类型检查、存储边界检查 | 通过 | 2026-11-13 |
| 全量 `npm test` | 1117 个文件中 1116 通过、1 跳过（14392 项） | 2026-11-14 |
| preload / renderer 类型检查、`npm run build` | 通过 | 2026-11-14 |
| 打包版真机验证 | 未做 | — |

## 5. 偏离计划

- 计划外顺手修了一处分层遗留：`scripts/packaging/electron-builder-config.test.mjs` 仍按旧路径 `src/main/music/scripts/qqmusic_gsmtc.ps1` 检查打包配置，分层后实际在 `src/main/platform/music/scripts/`。这个测试不在 vitest 全量里，分层时没被发现；与本计划要改的同一个测试文件，一并改正。
- 发现但未修：`scripts/verify/memory-core/probe-root.test.mjs` 把工作目录写死为历史路径 `E:\Codex\Firefly_Agent-skills-layout\output\task-b-memory-core`，在任何工作区都失败。与数据目录无关，留给“文档与工程”施工包 D（脚本测试接入 CI）处理。
