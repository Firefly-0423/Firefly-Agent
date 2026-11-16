# 主进程七层架构分层与内部定序重构

状态：基本完成（结构重构与内部定序已随 PR #57–#60 合入；运行级真机及打包版验收待执行）  
日期：2026-11-12（设计与计划确立日）

## 为什么做

重构前排查显示（`docs/design/2026-11-12-main-process-layering.md`）：虽然三端类型检查、IPC 235 通道与单元测试可正常通过，但 `src/main` 下 50 个目录缺少上下层边界，其中 37 个目录互相可达，任一目录改动在依赖图上可能波及其余 36 个目录。主要成因有二：

1. **通用基础设施放在了上层目录**：例如 `ipc-scope`、`window-activation` 位于 `application/`、`toast-events`/`user-choice`/`ask-card` 位于上层业务目录，导致底层反过来引用上层。
2. **`orchestrator` 单目录耦合了六类职责**：模型厂商接入、结构化输出、会话记录、`tools` 注册契约、内置工具、MCP 与运行循环全部堆在一起，记忆与设置模块仅需要局部类型或记录读写也被迫引用整个 `orchestrator`。

目标是将 `src/main` 按自底向上的七个概念层级（共 10 个顶层目录）重组，每层写明 `AGENTS.md`，并由自动化架构测试锁死引用方向。

## 改了什么（前后结构对照）

| 维度 | 重构前 | 重构后 |
| --- | --- | --- |
| 顶层组织 | `src/main` 下约 50 个平铺业务/技术目录，`orchestrator/` 混合 L2–L4 职责，`harness` 作为运行内核命名 | `src/main/layers.json` 定义 L0–L6 共 10 个层目录：`base`（L0）、`platform`（L1）、`model`/`tooling`/`conversation`（L2）、`knowledge`/`memory`（L3）、`agent`（L4）、`features`（L5）、`app`（L6）；每个层目录配有 `AGENTS.md` |
| 通用文件与 `orchestrator` 拆解 | 通用工具散落上层；`orchestrator` 一锅端 | 先行将 12 个错位通用文件迁往底层（`f1a1c46`），随后在 `26d2573` 迁动 1468 个文件、拆解 `orchestrator` 至 `model`/`conversation/transcript`/`tooling/registry`/`agent`，并拆出 `harness` 为 `agent/loop` |
| 跨层向上引用 | 挪动后暴露 102 处向上引用（另加 `memory` 内部 14 处、`agent` 内部 58 处）；由 `layering-known-violations.json` 临时记账 | 经多批拆解（`8da58c2` → `01f5035`）彻底清零跨层违例（如回调/端口注入 `createRunAdjustmentPoller`、`selectCachedHistoryCoverage`、`UserMemoryRecallSource`），在 `ff29673` 删除存量例外清单 |
| 模块内部定序 | `memory` 内部 `repository.ts` 耦合下层；`agent` 子目录互相引用且沿用 `harness*` 命名 | `693590b` 在 `layers.json` 加入 `memory` `internal` 分序（`core` → `shadow` → `sources` → `policy` → `recall` → `history` → `context` → `database` → `legacy`）；`06573a7` 加入 `agent` `internal` 分序并拆出 `src/main/agent/loop/run-ports.ts`；`a7f375e` 全仓将 `harness*` 重命名为 `agent-loop*`（96 个文件） |
| 文件级循环与死代码 | 存在 `obsidian-exporter ↔ memory-store` 与 `ChatMessageList ↔ StreamdownMessageContent` 两个文件级循环，及一批仅自测的未引用模块 | `1d6d925` 通过 `ObsidianExportSource` 参数与 `src/renderer/react/features/chat/components/message-contexts.ts` 打破两处文件循环；`be1803e` 删除 38 个未引用模块及其专属测试（-1612 行） |
| 守护测试 | 无自动依赖方向门禁 | 新增 `src/main/layering.test.ts` 与 `src/main/layers.json`，强制验证零向上/循环违例，禁止再靠例外列表绕过 |

## 怎么验证的

1. **架构分层检查**：`src/main/layering.test.ts` 对 `src/main` 全量导入进行方向断言（存量例外清零，零违例）。
2. **三端类型检查与构建**（记录于 `2026-11-12-main-process-layering-progress.md` 与 `5e0eb8e`）：`tsconfig.main.json`、`tsconfig.preload.json`、`tsconfig.renderer.json` 均通过；`npm run build`、`npm run check:storage-boundary`、`npm run check:plugin-schema` 通过。
3. **测试验证**：
   - 分层完成 PR `#57` 前 `npm test` 跑完 1131 个文件（1129 通过、1 跳过，1 个因补导出另行单独跑 27 项通过；未再重跑全量）。
   - PR `#58` 内部定序期间分域回归：memory/app/rag 测试（193 个文件，含 worker 集成测试）、agent/features/app/tooling 测试（356 个文件、4637 项）通过。
4. **开发启动初验**：使用隔离数据目录启动开发版，聊天、桌宠、提醒三窗可打开且无启动报错。

## 涉及的 PR

- **PR `#57`**（`2dab331`，2026-11-13）：`refactor(主进程): 按七层重组 src/main 并用测试守住引用方向`（涵盖预清理 `f1a1c46`、1468 文件搬移 `26d2573`、分批清零 102 处向上引用与删除例外清单）。
- **PR `#58`**（`5e0eb8e`，2026-11-13）：`refactor(主进程): 记忆层与运行层内部定序，Harness 改名 Agent Loop，清理循环与死代码`（涵盖 `1d6d925`、`693590b`、`be1803e`、`06573a7`、`a7f375e`）。
- **PR `#59`**（`bcec7f8`，2026-11-13）：`chore(主进程): 把 #58 的内容带进 dev/firefly-1.2.0`（一并更新 README 架构表与多份验证脚本路径）。
- **PR `#60`**（`10d4462`，2026-11-14）：`docs/plans-new-paths`（同步计划与工程文档中的分层后新路径）。

## 遗留事项

1. **运行级真机与打包版验证未执行**（`2026-11-12-main-process-layering-progress.md` §3）：真实模型配置下分别运行 Chat / Work / Code、设置窗口、插件面板、截图、音乐脚本及完整安装包实测尚未执行。
2. **进度与设计文档同期同步缺口**：PR `#58` / `#59` 实际已完成原计划中的 H（memory 内部定序）、I（agent 内部定序与 `agent-loop` 更名）、J（文件级循环）和 K（死代码删除），但 `docs/superpowers/plans/2026-11-12-main-process-layering-progress.md` 仍停留于 PR `#57` 时的状态未更新；此外进度文档 §5 记录实际新增了 `agent/memory-runtime`、`model/prompt`、`features/settings` 等细分子目录，`docs/design/2026-11-12-main-process-layering.md` §3 目录树尚待同步。
3. **另立设计的其他区域**：设计 §8 预留的 `src/preload/index.ts`、`src/renderer` 与 `src/plugins` 拆分中，preload 已单独立项完成，settings 正在推进中。
