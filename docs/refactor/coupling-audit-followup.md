# 耦合审计遗留项清理与跨进程/日志/诊断治理

状态：计划内 R1–R4 与 R6 已完成合并；大文件拆解（R5）中 preload 已完成、settings 进行中，其余大文件待单独立项  
日期：2026-11-14（首个计划合并 PR `#66` 合并日；施工计划与进度文件按 `2026-11-15` 命名）

## 为什么做

主进程七层分层（PR `#57`–`#59`）解决了 `src/main` 内部目录缠绕与两处文件循环，但前期耦合审查仍有五类遗留问题未清（`docs/superpowers/plans/coupling-audit-followup.md`）：

1. **跨进程边界失守**：渲染进程生产代码（`qqmusic-panel.ts`）与 preload（`music.ts`）仍直接引用 `src/main` 类型；
2. **测试辅助文件混入生产编译**：仅有测试引用的扫描器/构建器（`history-index-builder.ts`、`ipc-contract-scanner.ts`、`default-dialogs-scanner.ts`）没有测试后缀，生产代码可误引用，且会随 `tsc` 打入 `dist/main` 安装包；
3. **静默异常与类型逃逸**：4 处未写注释的空 `catch` 与 18 处生产 `as any`（还掩盖了 `l2-dmae-manager` 状态大写不一致问题）；
4. **日志旁路与脱敏不足**：主进程 189+ 处直接调 `console.log/info/debug` 绕过 `logger`（不受 `FIREFLY_LOG_LEVEL` 控制、不入 `main.log`），部分日志直接打印敏感错误文本或完整 URL（含查询参数/令牌路径）；
5. **一次性诊断入口开关越权与路径硬编码**：正式打包版未禁用 `online-once`/`openrouter-once` 诊断开关，且硬编码绝对输出目录吞错退出。

## 改了什么（前后结构对照）

| 施工包 | 整改前 | 整改后 |
| --- | --- | --- |
| **R1 跨进程边界**（PR `#67`） | `qqmusic-panel.ts` 与 `src/preload/music.ts` 直接引用 `src/main/platform/music/qqmusic-service.ts` 的类型 | 共享类型抽取至 `src/shared/qqmusic-types.ts`；新增 `src/shared/process-boundary.test.ts` 沿相对导入（含经 `src/shared` 中转）校验渲染进程与 preload 生产代码零引用 `src/main`（保留 3 个跨进程一致性对照测试） |
| **R2 测试专用文件隔离**（PR `#68`） | `history-index-builder.ts`、`ipc-contract-scanner.ts`、`default-dialogs-scanner.ts` 与 `knowledge/skills/testing/` 夹具以普通 `.ts` 命名，可被生产代码引用且被编入 `dist/main` | 全部更名为 `*.test-support.ts` 并加注只供测试声明；`layering.test.ts` 与 `process-boundary.test.ts` 将生产代码引用测试文件判为违例；`tsconfig.main.json` 与 `tsconfig.preload.json` 排除 `*.test-support.ts` 并按 `tsc` 解析列表断言 `dist/` 无测试产物 |
| **R3 空 catch 与 `as any`**（PR `#69`、`#71`） | 4 处空 `catch` 无注释说明；生产代码存在 18 处 `as any`（及 `l2-dmae-manager.ts` 掩盖的大小写状态差异） | 为 4 处合理空 `catch` 补明理由注释；全部 18 处生产 `as any` 替换为精确类型/守卫并 `git grep` 清零；独立 PR `#71` 修复 DMAE 状态读写大小写映射与坏条目读取耐受 |
| **R4 日志收敛与脱敏**（PR `#75`） | 主进程大量 `console.log/info/debug` 直接直出且含 URL 路径/查询串或原始服务商异常 | 开发默认 `info`、安装版默认 `warn`（`FIREFLY_LOG_LEVEL` 优先）；分目录迁移 189 处至 `logger`；新增 `src/main/base/logging/url-for-log.ts`（仅记协议+主机并标注有无路径/查询串）；修改微信日志缺失发送者ID抛错与模型失败回显原始文本；新增 AST 校验 `src/main/console-usage.test.ts` 守护 `src/main` 生产文件（`features/diagnostics/**` 与烟测入口例外） |
| **R6 诊断门禁与覆盖**（PR `#70`、`#84`） | 安装版未屏蔽诊断启动参数，且输出目录硬编码吞错退出 1 | `src/main/base/identity/startup-entry.ts` 增加 `diagnosticSwitchesAllowed(!app.isPackaged)` 门禁（PR `#70`）；PR `#84` 增加 `FIREFLY_MEMORY_ONLINE_DIAGNOSTIC_BASE` / `FIREFLY_OPENROUTER_DIAGNOSTIC_BASE` 覆盖并把错误码打到 stderr |

## 怎么验证的

1. **R1**：边界、分层与音乐测试 23 项及三端类型检查通过。
2. **R2**：`memory/history`、`memory/context`、`app`、`default-dialogs-regression.test.ts`、`shared`、`layering.test.ts` 共 97 个文件 1770 项通过；反向在生产代码引用测试辅助文件触发报错；`npm run build:main` 后确认 `dist/main` 无测试辅助产物。
3. **R3**：217 个文件 2516 项通过，三端类型检查通过，`git grep "as any"`（非测试）为 0；PR `#71` `memory/legacy` 283 项通过。
4. **R4**：`npx vitest run src/main`（带 `FIREFLY_TEST_BASH`）800 个文件 11255 项通过、11 项跳过；`src/main/console-usage.test.ts` AST 扫描与反向验证通过；审查后对模型敏感文本、URL 令牌与微信无 `fromUserId` 先写失败测试再修复通过。
5. **R6**：入口测试 9 项、`default-dependencies.test.ts` 等全部通过；PR `#84` 后 `memory-online-startup`（12 用例）与 `memory-openrouter-once`（25 用例）脚本验证通过。

## 涉及的 PR

- **PR `#66`**（`b66e325`，2026-11-14）：`docs/coupling-followup-plan`（计划文件 `coupling-audit-followup.md`）。
- **PR `#67`**（`a96f254`，2026-11-14）：`feat/coupling-r1`（R1 跨进程边界与 `qqmusic-types.ts`）。
- **PR `#68`**（`623d2d4`，2026-11-15）：`feat/coupling-r2`（R2 测试辅助文件更名与产物排除）。
- **PR `#69`**（`8e93484`，2026-11-15）：`feat/coupling-r3`（R3 空 catch 与全量清除 `as any`）。
- **PR `#70`**（`2a5c383`，2026-11-15）：`feat/coupling-r6`（R6 打包版禁用一次性诊断参数）。
- **PR `#71`**（`89d705c`，2026-11-15）：`fix/dmae-state-case`（R3/R4 衍生 L2 DMAE 状态大小写修复与规范化容错）。
- **PR `#75`**（`5c1b66d`，2026-11-15）：`feat/coupling-r4`（R4 全目录日志迁至 `logger` 与脱敏）。
- **PR `#84`**（`1d739c0`，2026-11-15）：`fix/diagnostic-base-override`（R6 诊断基目录环境变量覆盖与错误透传）。

## 遗留事项

1. **其余大文件尚未拆分**（`coupling-audit-followup.md` §现状）：除 `preload/index.ts` 已完成拆解、`settings.ts` 处于拆解中（PR 3–4 待续）外，`ChatPage.tsx`（1592 行，计划在回归包 A–H 保护完成后再拆）、`main-default-memory.ts`（1137 行）、`default-dependencies.ts`（978 行）、`agui-bridge.ts`、`AgentRunController.ts`、`git-service.ts` 均尚未另立拆分 PR；`src/plugins/` 重构划归 1.2.0 SDK 规格。
2. **已知未修关联问题**：[l2-dmae-malformed-entries.md](../internal-issue/l2-dmae-malformed-entries.md)（`getL2DmaeState`/`updateL2DmaeState` 遇 `null` 条目抛错，已决定延后）与 [diagnostic-hardcoded-root.md](../internal-issue/diagnostic-hardcoded-root.md)（源码保留历史绝对路径默认值）。
