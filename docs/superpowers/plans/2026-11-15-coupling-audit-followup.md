# 耦合审查遗留项施工计划

状态：已确认，施工中
来源：2026-11-12 的耦合与错误排查（阶段性结果，存于 `output/audit-1.2.0/coupling-audit.md`，不入库）。分层（#57–#59）已解决目录缠绕、`ipc-scope` 等放错位置的文件、memory-core 反向引用和两个文件级循环。本计划处理剩下的项。数据于 2026-11-15 在 `dev/firefly-1.2.0` 的 `27cbfca` 上重新核对。

**目标：** 清掉审查里剩下的结构问题和写法问题：
- 渲染进程越层引用；
- 只有测试在用的文件；
- 没写原因的空 catch；
- `as any`；
- 绕过日志模块的 `console.log`。

大文件拆分先出设计，负责人确认后再动手。

**不在本计划内：**
- `src/plugins/api.ts` 与 `plugin-sdk/src/api.ts` 完全相同，`src/plugins/manager.ts` 917 行：归 SDK 1.2.0 规格（`docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md`），重写时合一。
- `ChatPage.tsx` 1592 行：先按 ChatPage 回归计划补齐回归测试，拆分放在回归测试之后另立计划，避免没有保护就动最大的页面。
- `node-forge` 中危：已登记在依赖风险登记表（`docs/security/dependency-risk-register.md`）。

## 现状（2026-11-15 核对）

| 项 | 情况 |
|---|---|
| 疑似死代码 | 审查列出的 17 个文件里，14 个已在 1.2.0 重写中删除。剩下：`src/main/app/ipc-contract-scanner.ts`、`src/renderer/default-dialogs-scanner.ts`（契约测试用的扫描工具），`src/main/memory/history/history-index-builder.ts`（只有 `firefly-history-reader.test.ts` 引用） |
| 渲染进程越层 | 生产代码 1 处：`src/renderer/settings/music/qqmusic-panel.ts` 引用 `src/main/platform/music/qqmusic-service.ts` 的类型。另有 3 个渲染进程测试直接引用主进程模块 |
| 空 catch | 生产代码 4 处：`s-response-stream.ts:60`，`windows-shell-job.ts:102`（内嵌的 PowerShell 脚本），两个诊断入口的 `fail()` |
| `as any` | 生产代码 19 处，分布在 7 个文件；其中 `renderer/settings/rag/panel.ts` 3 处，`native-history-zero-write.acceptance.ts` 1 处属于验收脚本 |
| `console.log` | 生产代码 237 处：主进程 225、渲染进程 9、插件宿主 3。主进程的 `console.log` 不经过 `logger`，不受 `FIREFLY_LOG_LEVEL` 控制，也不写入 `main.log`。主进程现有 `logger` 调用 119 处 |
| 大文件 | `renderer/settings/settings.ts` 1629 行、`preload/index.ts` 1257 行、`agent/memory-runtime/main-default-memory.ts` 1137 行、`app/default-dependencies.ts` 978 行（引用 130 个模块）、`features/chat/agui-bridge.ts` 871 行、`AgentRunController.ts` 870 行、`platform/git/git-service.ts` 823 行 |

## 全局约束

- 测试按 `AGENTS.md` 的断言写法，先写测试，确认失败后再改实现。
- 每个施工包一个 PR；不顺手改无关代码。
- 分层检查（`src/main/layering.test.ts`）保持零违例。
- 日志改动不得把密钥、令牌、用户内容写进日志：迁移时逐条看参数，只记录分类、编号、计数这类信息。

## 施工包

### 施工包 R1：渲染进程不再引用主进程

依赖：无

- [ ] R1.1 音乐面板的类型
  - 先写的测试：新增分层检查：`src/renderer` 的生产文件不得引用 `src/main`（测试文件除外）。现在有 1 处违例，测试应失败。
  - 实现：把 `QqMusicAction`、`QqMusicControlResult`、`QqMusicState` 移到 `src/shared`，主进程和渲染进程都从那里引用。
  - 验证：`npm test -- src/main/layering.test.ts src/renderer/settings/music src/main/platform/music`，以及 `npm run check:renderer`
- [ ] R1.2 渲染进程测试直接引用主进程
  - 范围：`agent-routing.test.ts`、`presets.test.ts`、`timezone-options.test.ts`。
  - 做法：逐个看。被测的是共享逻辑的，把逻辑移到 `src/shared`；本来就是测主进程行为的，把测试挪回主进程目录。
- 验收：渲染进程与主进程之间只通过 preload 和 `src/shared` 联系。

### 施工包 R2：只有测试在用的文件

依赖：无

- [ ] R2.1 `history-index-builder.ts`
  - 核对：生产的历史读取是否已经不用它。不用了的，看 `firefly-history-reader.test.ts` 拿它做什么：
    - 作为对照答案的，留在测试一侧，改名为测试辅助文件，放在同目录；
    - 已经没有意义的，连同测试用例一起删除，并在提交说明里写明理由。
- [ ] R2.2 两个扫描器
  - 范围：`ipc-contract-scanner.ts`、`default-dialogs-scanner.ts`。
  - 做法：它们是契约测试的工具，保留；在文件开头写明"只供测试使用"。
  - 先写的测试：分层检查增加一条：生产文件不得引用这两个扫描器。
- 验证：`npm test -- src/main/memory/history src/main/app src/renderer/default-dialogs-regression.test.ts`

### 施工包 R3：空 catch 与 `as any`

依赖：无

- [ ] R3.1 空 catch
  - 范围：4 处。
  - 做法：每处补一行注释，说明为什么可以忽略，例如"退出路径，失败也必须继续退出"。不能忽略的，改为用 `logger.warn` 记录分类信息。内嵌 PowerShell 脚本里的那处只补注释。
- [ ] R3.2 `as any`
  - 范围：19 处，验收脚本那 1 处除外。
  - 做法：逐处换成具体类型或 `unknown` 加类型收窄。换不了的（第三方库类型缺失），写明原因并收窄到最小范围。
  - 先写的测试：每处改动涉及的行为如果原来没有测试覆盖，先补测试，再改类型。
- 验证：三端类型检查，加上相关模块的测试。

### 施工包 R4：主进程日志统一走 `logger`

依赖：无。改动面较大，可按目录拆成多个 PR。

- [ ] R4.1 规则与检查
  - 先写的测试：新增检查：`src/main` 的生产文件不得直接调用 `console.log` / `console.info` / `console.debug`（`console.error`、`console.warn` 暂不限制）。
  - 例外清单只放两类：命令行工具、诊断与模拟脚本，即 `features/diagnostics/**` 和 `features/diagnostics/sim/**`。它们的输出本来就是给终端看的。
- [ ] R4.2 按目录迁移
  - 顺序：agent、memory、features、platform、其余。
  - 做法：
    - 把 `console.log` 换成 `logger.info` 或 `logger.debug`，带上对应的 `LogTag`；
    - 逐条检查参数，原来输出用户内容、路径全文、命令全文的，改为输出摘要或计数；
    - 每个目录迁完，跑该目录的测试；
    - 原有测试断言 `console.log` 的，改为断言 `logger`。
- 验收：检查通过；开发版启动后，`main.log` 里能看到 info 级别的启动记录（需设置 `FIREFLY_LOG_LEVEL=info`）。

### 施工包 R5：大文件拆分设计

依赖：R1–R4 不依赖它；它本身只出设计文档。

- [ ] R5.1 为下面 5 个文件分别写拆分设计（负责人决定：先做 `settings.ts`、`preload/index.ts` 两份试点），放在 `docs/design/`：
  - `settings.ts`
  - `preload/index.ts`
  - `main-default-memory.ts`
  - `default-dependencies.ts`
  - `agui-bridge.ts`
  - 每份设计写清楚：
    - 现在承担了哪几件事；
    - 按什么边界拆；
    - 拆完每个文件的职责和对外接口；
    - 哪些现有测试能保护这次拆分，缺哪些测试要先补；
    - 分几个 PR 做。
- [ ] R5.2 负责人确认设计后，每个文件另立施工计划实施。
- 说明：
  - `default-dependencies.ts` 是组合根，引用多是正常的。拆分目标是按层分组装配，而不是减少引用。
  - `AgentRunController.ts`、`git-service.ts` 暂不列入，先看前 5 个文件的拆分效果。

## 验收清单

- [ ] R1–R4 各自合并，验证通过
- [ ] R5 的 5 份设计经负责人确认
- [ ] 全量 `npm test`、三端类型检查、`npm run build` 通过
- [ ] 开发版启动正常，`main.log` 记录完整

## 回滚

R1–R4 每包只涉及各自范围，revert 对应 PR 即可。R4 迁移日志不改行为，只改输出位置和级别。

## 负责人决定（hotaru，2026-11-15）

1. R4：开发版默认日志级别为 info，安装版保持 warn。R4.1 一并实现这条默认值，并补测试。
2. R5：先做 `settings.ts` 和 `preload/index.ts` 两份拆分设计作为试点，看效果后再决定其余三份。
