# 耦合审查遗留项施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-coupling-audit-followup.md](./2026-11-15-coupling-audit-followup.md)

## 1. 当前状态

- 分支：`feat/coupling-r4`
- 进行到：R4 完成（R4.1 默认级别与检查规则、R4.2 全部目录迁移）

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
| R4.1 日志级别与检查规则 | `b85605e`：开发版默认级别为 info，安装版为 warn，环境变量 `FIREFLY_LOG_LEVEL` 优先。新增 `src/main/console-usage.test.ts`：用 TypeScript 语法树扫描 `src/main` 的生产文件，除 `features/diagnostics/**` 外不得调用 `console.log` / `console.info` / `console.debug`（`console.warn` / `console.error` 不限制）；检测函数另有 2 项自测（命中 `console['debug']`，不误报字符串和注释里的 `console.log`）。反向验证：往 `model/structured/runner.ts` 临时加一行 `console.log("x")`，检查报出 `model/structured/runner.ts:171`，还原后通过 | 检查 3 项通过 |
| R4.2 按目录迁移 | 189 处 `console.log/info/debug` 改走 `logger`：agent/mcp 18、agent/loop 2、agent/services 9、agent/runtime 14、agent/tools 39、memory 23、features 36、platform 15、knowledge 15、model 9、app 5、base 4。新增日志标签 `Memory`、`Proactive`；新增 `base/logging/url-for-log.ts`（只保留协议、主机、路径，丢掉账号密码、查询串、片段），抓取、下载、读图、视觉模型的日志用它。原来输出用户消息、记忆内容、文件全文、命令全文、完整 URL、完整路径、城市和起终点的，改为长度、计数、文件名或类别。每个目录单独一个提交，各自通过类型检查和该目录测试；断言 `console.log` 的 11 个测试文件改为断言 `logger` | 见下 |
| R6 一次性诊断只在开发版可用 | `startup-entry.ts` 新增 `diagnosticSwitchesAllowed(isPackaged)`，`dispatchMainEntry` 接收是否允许诊断：不允许时两个诊断参数都忽略，按正常启动处理，并回调 `ignored`。`index.ts` 传入 `!app.isPackaged`，被忽略时记一条 warn。`default-dependencies.ts` 只在允许时才启用 online-once 探针入口。两个验证脚本去掉打包模式用例。按设计分 4 个代码提交，每个单独通过 | 入口测试 9 项（新增 4 项：判定本身，安装版带 online-once、openrouter-once、两者同时都走正常启动并回调，安装版不带参数时不回调）；`default-dependencies` 新增开发版和安装版两项，安装版那项先失败、实现后通过 |

## 3. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| R1：`npx vitest run src/shared/process-boundary.test.ts src/main/layering.test.ts src/renderer/settings/music src/main/platform/music src/main/features/music` | 23 项通过 | 2026-11-15 |
| R1：三端类型检查 | 通过 | 2026-11-15 |
| R2：`npx vitest run src/main/memory/history src/main/memory/context src/main/app src/renderer/default-dialogs-regression.test.ts src/shared src/main/layering.test.ts` | 97 个文件、1770 项通过 | 2026-11-15 |
| R2：三端类型检查、`npm run build:main` | 通过 | 2026-11-15 |
| R3：`npx vitest run src/main/agent/runtime src/main/agent/tools/builtin-tools src/main/knowledge/rag src/main/knowledge/stickers src/main/knowledge/workspace/obsidian src/main/memory/context src/main/memory/legacy src/renderer/settings src/main/layering.test.ts src/shared/process-boundary.test.ts`（带 `FIREFLY_TEST_BASH`） | 217 个文件、2516 项通过 | 2026-11-14 |
| R3：三端类型检查、`git grep -n "as any" -- 'src/*.ts' 'src/*.tsx' ':!*.test.*' ':!*.acceptance.*'` | 类型检查通过；grep 无结果 | 2026-11-14 |

| R6：`npx vitest run src/main/base/identity src/main/app/default-dependencies.test.ts src/main/app/external-skills-wiring.test.ts src/main/layering.test.ts`，读入口文件的 3 个测试，`electron-builder-config.test.mjs` | 全部通过 | 2026-11-15 |
| R6：`tsc -p tsconfig.main.json --noEmit`；两个验证脚本 `node --check` | 通过 | 2026-11-15 |
| R4：`npx vitest run src/main`（带 `FIREFLY_TEST_BASH`） | 800 个文件、11255 项通过、11 项跳过 | 2026-11-15 |
| R4：`tsc -p tsconfig.main.json` / `tsconfig.preload.json` / `tsconfig.renderer.json --noEmit`，`npm run build:main` | 全部通过 | 2026-11-15 |
| R4：`git grep -nE 'console\.(log|info|debug)\(' -- src/main ':!*.test.*' ':!*.acceptance.*' ':!*.test-support.*' ':!src/main/features/diagnostics'` | 只剩 `ast-grep-tools.ts` 工具说明文字里的字符串 `console.log($$$ARGS)`，不是调用 | 2026-11-15 |

## 4. 偏离计划

- R1.1 的检查同时覆盖 preload，多发现 `preload/music.ts` 一处，一并修掉。
- R1.2 计划写的是"逐个看，要么移逻辑要么挪测试"，实际 3 个都是跨进程一致性测试，保留原样。
- R2 计划外加了 R2.3：测试辅助文件原来会进安装包，一并排除。
- R3.2 发现一处原来被 `as any` 盖住的类型不一致：`deriveState` 返回首字母大写的 `DmaeState`（`Active` / `Dormant` / `Archived`），而 `L2DmaeState.state` 声明为小写。`l2-dmae-manager.ts` 的 `buildEntries` 里那处值没有被使用，已通过收窄 `toDmaeEntry` 的参数去掉 `as any`，运行结果不变；但 `updateL2DmaeState` 那处的 `as L2DmaeState["state"]` 会把大写值写进持久化数据，按"只改类型"没有处理，留给负责人决定是改类型还是改写入值。
- R6 是计划外新增：R3 核对时发现，负责人当天决定。写死的历史目录 `E:\Codex\2026-10-01\task\...` 这次没动，诊断代码现在只在开发版能走到。
- R3 核对中发现、负责人决定修（默认小写，首字母大写的映射为小写）：`knowledge/rag/worldbook.ts` 的 `deriveState` 返回首字母大写的 `"Active"`，`l2-dmae-manager.ts` 同步时把它写进声明为小写的 `L2DmaeState.state`。分支 `fix/dmae-state-case` 上分两个行为修复提交：写入时用类型化的映射表转成小写，去掉了掩盖问题的类型断言；读入 `memory.json` 时把已存的首字母大写值映射为小写，下次保存即落盘。两处都附了测试，修复前失败、修复后通过；`src/main/memory/legacy` 283 项通过。
- R4：`platform/permission/permission.ts` 被 `knowledge/skills/external-boundary.test.ts` 固定了内容哈希。这次只把 6 处 `console.log` 换成 `logger.info`，没动判定逻辑，哈希随平台目录的提交一起更新，并在测试里注明原因，请负责人确认。
- R4：`base/logging/agent-log.ts` 的 `debugLog` 仍受 `FIREFLY_DEBUG_LOGS=1` 控制，打开后以 info 级别输出；安装版默认 warn，要同时设 `FIREFLY_LOG_LEVEL=info` 才能看到。
- R4：`features/music/music-smoke-entry.ts` 是烟测入口，不在 `features/diagnostics/**` 下，按规则也迁到了 `logger`。

