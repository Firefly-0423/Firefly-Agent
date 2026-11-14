# 耦合审查遗留项施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-coupling-audit-followup.md](./2026-11-15-coupling-audit-followup.md)

## 1. 当前状态

- 分支：`feat/coupling-r3`
- 进行到：施工包 R3 完成

## 2. 已完成项

| 任务 | 改动 | 验证 |
|---|---|---|
| R1.1 音乐面板的类型 | 新增 `src/shared/process-boundary.test.ts`：渲染进程与 preload 的生产代码不得引用 `src/main`。先跑失败，正好报出 `qqmusic-panel.ts` 与 `preload/music.ts` 两处（审查时只发现渲染进程那处）。三个类型移到 `src/shared/qqmusic-types.ts`；主进程服务从那里引入并转出，`features/music/bootstrap.ts` 不用改 | 边界、分层与音乐相关测试 23 项通过；main / preload / renderer 类型检查通过 |
| R1.2 渲染进程测试引用主进程 | 3 个测试都保留：`agent-routing.test.ts`、`presets.test.ts`、`timezone-options.test.ts` 核对的是设置页的选项与主进程实际行为是否一致（例如设置页给出的每个时区，主进程都接受），本来就需要同时引用两边。边界检查只管生产代码 | — |
| R2.1 `history-index-builder.ts` | 生产的历史查询走 `history-repository.ts`，这个构建器只剩 `firefly-history-reader.test.ts` 在用，拿它检查读取结果进索引后，密钥、中断回复等查不到（9 处断言，有价值）。改名为 `history-index-builder.test-support.ts`，文件开头写明只供测试使用 | 读取测试通过 |
| R2.2 两个扫描器 | `ipc-contract-scanner.ts`、`default-dialogs-scanner.ts` 改名为 `*.test-support.ts`，文件开头写明只供测试使用。分层检查原来会跳过对测试辅助文件的引用，生产代码引用了也不报；现在 `layering.test.ts` 和 `process-boundary.test.ts` 都把"生产代码引用测试文件"算作违例 | 反向验证：在主进程和渲染进程各临时加一条引用，两条检查都报出 `(引用测试文件)` |
| R2.3 测试辅助文件不进安装包（计划外） | 核对时发现 `*.test-support.ts` 会被 `tsc -p tsconfig.main.json` 编进 `dist/main`，再随 `dist/**/*` 进安装包（`ipc-contract-scanner` 还引用开发依赖 `typescript`）。先在 `process-boundary.test.ts` 断言 `tsconfig.main.json` 排除 `src/**/*.test-support.ts`（失败），再加排除 | 重新 `npm run build:main` 后 `dist/main` 里没有测试辅助文件 |
| R3.1 空 catch | 4 处补了注释，说明为什么可以忽略：`s-response-stream.ts`、`windows-shell-job.ts` 内嵌 C# 代码、两个诊断入口的 `fail()` | 相关 54 个文件 1047 项通过 |
| R3.2 `as any` | 生产代码里的 18 处全部换成具体类型，`git grep "as any"`（不含测试和验收脚本）结果为 0。`agent-runtime.ts` 8 处改用 `Parameters<typeof 函数>[n]` 收窄；`run-verification-tool.ts` 用 `VerificationType`；`rag/index.ts` 复用已有的 `rawEntries()`；`sticker-storage.ts` 用 `readonly string[]`；`obsidian-tools.ts` 用 `ObsidianEditRequest`；`openrouter-bounded.ts` 用响应形状接口加 `never` 返回的 `uncertain()`（判定条件未动）；`l2-dmae-manager.ts` 把 `toDmaeEntry` 的参数收窄到它真正读取的字段；`rag/panel.ts` 改用已有的 `window.settings` 类型并补上缺的 `getRerankerStatus`；`parse.ts` 改用 `Number.isNaN(Number(input))` 和 `unknown`。新增测试：agent-runtime 适配层 4 项、run_verification 步骤类型断言、嵌入模型切换 2 项、obsidian_edit 2 项、OpenRouter 用量 11 项、RAG 面板 5 项、`parsePositiveIntOrThrow` 12 项。每个文件单独一个提交 | 相关 217 个文件 2516 项通过；main / preload / renderer 类型检查通过 |

## 3. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| R1：`npx vitest run src/shared/process-boundary.test.ts src/main/layering.test.ts src/renderer/settings/music src/main/platform/music src/main/features/music` | 23 项通过 | 2026-11-15 |
| R1：三端类型检查 | 通过 | 2026-11-15 |
| R2：`npx vitest run src/main/memory/history src/main/memory/context src/main/app src/renderer/default-dialogs-regression.test.ts src/shared src/main/layering.test.ts` | 97 个文件、1770 项通过 | 2026-11-15 |
| R2：三端类型检查、`npm run build:main` | 通过 | 2026-11-15 |
| R3：`npx vitest run src/main/agent/runtime src/main/agent/tools/builtin-tools src/main/knowledge/rag src/main/knowledge/stickers src/main/knowledge/workspace/obsidian src/main/memory/context src/main/memory/legacy src/renderer/settings src/main/layering.test.ts src/shared/process-boundary.test.ts`（带 `FIREFLY_TEST_BASH`） | 217 个文件、2516 项通过 | 2026-11-14 |
| R3：三端类型检查、`git grep -n "as any" -- 'src/*.ts' 'src/*.tsx' ':!*.test.*' ':!*.acceptance.*'` | 类型检查通过；grep 无结果 | 2026-11-14 |

## 4. 偏离计划

- R1.1 的检查同时覆盖 preload，多发现 `preload/music.ts` 一处，一并修掉。
- R1.2 计划写的是"逐个看，要么移逻辑要么挪测试"，实际 3 个都是跨进程一致性测试，保留原样。
- R2 计划外加了 R2.3：测试辅助文件原来会进安装包，一并排除。
- R3.2 发现一处原来被 `as any` 盖住的类型不一致：`deriveState` 返回首字母大写的 `DmaeState`（`Active` / `Dormant` / `Archived`），而 `L2DmaeState.state` 声明为小写。`l2-dmae-manager.ts` 的 `buildEntries` 里那处值没有被使用，已通过收窄 `toDmaeEntry` 的参数去掉 `as any`，运行结果不变；但 `updateL2DmaeState` 那处的 `as L2DmaeState["state"]` 会把大写值写进持久化数据，按"只改类型"没有处理，留给负责人决定是改类型还是改写入值。
