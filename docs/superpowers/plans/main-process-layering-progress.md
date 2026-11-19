# 主进程分层施工进度

日期：2026-11-12（更新于 2026-11-19）
状态：结构重构、内部定序、循环与死代码清理及计划路径同步均已合并进 `dev/firefly-1.2.0`（PR #57–#60、#101）；运行级真机与打包版验证、以及部分渲染端/插件整理仍待做
施工计划：[main-process-layering.md](./main-process-layering.md)
设计：[docs/design/main-process-layering.md](../../design/main-process-layering.md)
回顾摘要：[docs/refactor/main-process-layering.md](../../refactor/main-process-layering.md)

本文是交接入口。换会话或换人时先读这里，再读施工计划。

## 1. 当前状态

- 主进程七层重构与第一批收尾（阶段 A–K、计划路径更新、文档去日期规范化）**已全部合入 `dev/firefly-1.2.0`**（主要合并 PR：#57、#58、#59、#60、#101）；原临时施工分支 `refactor/main-layering` 与独立工作区使命已结束，后续基于主线或 `dev/firefly-1.2.0` 推进。
- `src/main` 已按 `src/main/layers.json` 定义的十个层目录组织（同时对 `memory`、`agent` 配置层内 `internal` 子模块顺序）；`src/main/layering.test.ts` 检查全部引用方向与测试辅助边界，越层与层内违例为 0，且不存在例外清单（存量例外清单已于 `ff29673` 删除）。
- 另：`src/preload/index.ts` 与 `src/renderer/settings` 拆分已在后续 PR（#73–#78、#85–#87）完成主要阶段；当前仅余“运行级真机与打包版检查”以及主进程以外剩余区域整理为待做项。

## 2. 已完成项

| 提交 | 内容 | 越层引用 |
|---|---|---|
| `f1a1c46` | 挪走 12 个放错位置的通用文件（`ipc-scope`、`user-choice` 等） | — |
| `26d2573` | 1468 个文件按七层挪动，`orchestrator` 拆分，`harness` 目录改名 `agent/loop`；`layers.json`、`layering.test.ts`、各层 `AGENTS.md` | 102 |
| `8da58c2` | 模型档案 → `model/config`，设置 / 记忆 / 音乐的 IPC 与登记 → `features`，若干类型文件下沉 | 46 |
| `a041f18` | 各层 `AGENTS.md` 随挪动更新 | 46 |
| `3911f23` | 全量测试暴露的 6 处路径问题：音乐脚本路径、夹具字节、边界哈希、两处相对路径 | 46 |
| `859ec7d` | 记忆接入运行的 15 个文件 → `agent/memory-runtime`；`prompt-layers` → `model/prompt` 等 | 30 |
| `54c231b` | 运行侧的会话记录文件 → `agent/loop`；`ToolCallOutcome`、模式覆盖类型 → `src/shared`；`pending-adjustment` → `agent/runtime` 并改为传入存储；渠道文本与运行输入类型下沉 | 8 |
| `077beed` | 历史覆盖率诊断改为由组合根传入会话 id 读取函数 | 7 |
| `f8b9251` | 早期记忆工具的登记从注册表拆到 `agent/tools/legacy-memory-tools.ts` | 4 |
| `01f5035` | 检索模块改为由记忆层登记 `UserMemoryRecallSource`；写入证据读取下沉到 `tooling/execution` | 0 |
| `ff29673` | 严格化 `src/main/layering.test.ts` 并删除存量例外清单 | 0 |
| `07fc7bf` | `layers.json` 支持层内模块 `internal` 排序约束并接入守护测试 | 0 |
| `1d6d925` | **J**：消除两处文件级循环引用（抽出 `ObsidianExportSource` 传参打破 `obsidian-exporter ↔ memory-store`；抽出 `src/renderer/react/features/chat/components/message-contexts.ts` 打破 `ChatMessageList ↔ StreamdownMessageContent`） | 0 |
| `693590b` | **H**：记忆子模块 `src/main/memory` 按 `core → shadow → sources → policy → recall → history → context → database → legacy` 9 层定序写入 `src/main/layers.json` 并清零 14 处内部向上引用 | 0 |
| `be1803e` | **K**：删除 38 个文件（1612 行）——仅被自身测试引用的未用模块及其测试（`obsidian-importer`、`ask-answer-resolver`、`primary-window`、`window-layout`、旧模式按钮、`OfflineBrowserTab`、`WorkspaceSourcesPanel`、`browser-workspace-reducer`、`music-playback`、`minimax-voice`、`plugin-port-contract` 等） | 0 |
| `06573a7` | **I（前半）**：`src/main/agent` 按 `[services, tasks, sandbox, mcp] → [review, tools] → [loop] → [memory-runtime, runtime]` 4 组定序写入 `layers.json`，为循环层抽出 `src/main/agent/loop/run-ports.ts`，清零 58 处内部向上引用 | 0 |
| `a7f375e` | **I（后半）**：全仓 96 个文件统一将内部 `Harness*` 重命名为 `AgentLoop*` / `agent-loop*`（保留公共错误码 `E_HARNESS_FAILURE` 等对外契约字段） | 0 |
| PR `#57`–`#59` | 主进程七层重组与 H–K 内部定序重构合入 `dev/firefly-1.2.0`（含 README 架构表与验证脚本路径更新） | 0 |
| PR `#60` / `#101` | 施工计划与工程文档切换为分层后源码路径（#60 `10d4462`）；文档去日期命名与贡献指南归位（#101） | — |

行为相关的改动只有三处，都是把“下层直接引用上层”改成“上层传入或登记”，对外行为不变：
1. `createRunAdjustmentPoller` 的存储参数从“默认会话存储”改为必传（唯一的生产调用方原本就显式传入）。
2. `selectCachedHistoryCoverage` 改为接收会话 id 读取函数（组合根传入）。
3. 检索模块通过登记的 `UserMemoryRecallSource` 访问早期记忆库；没有登记时用户记忆检索返回空，与原来“记忆库加载失败时返回空”一致。登记在 `app/default-dependencies.ts` 引入 `memory/legacy/rag-recall-source.ts` 时完成。

## 3. 仍待做（未完成项）

原未完成项中的 **H（记忆内部分层）、I（智能体运行定序与 `AgentLoop*` 改名）、J（文件级循环）、K（死代码删除）、施工计划文档路径与分支合并**均已随 PR `#57`–`#60`、`#101` 完成并合入 `dev/firefly-1.2.0`。当前仅剩以下待做项：

| 项 | 当前状态 | 说明 |
| --- | --- | --- |
| 真机运行与打包版检查 | **待做** | 已做：隔离数据目录下开发版可启动，聊天/桌宠/提醒窗口打开无报错。**待做**：配置模型后实测 Chat / Work / Code 运行、设置窗口、插件面板、截图工具、音乐脚本以及打包版（NSIS / 免安装目录）冒烟。 |
| 主进程以外的目录整理 | **部分推进，整体待做** | `src/preload/index.ts` 已在 PR `#74` / `#76` / `#77` / `#85` / `#86` 按职责拆为工厂装配；`src/renderer/settings`（`settings.ts`）已在 PR `#73` / `#78` / `#87` 完成前两轮拆解（剩余收尾 PR 4 与三项既有缺陷见 [settings-post-split-bugs.md](../../internal-issue/settings-post-split-bugs.md)）。`src/renderer` 其余页面/组件与 `src/plugins` 的目录整理仍**待做**。 |
| 设计文档 §3 目录树同步 | **待做**（低优） | 实际细分子目录（如 `agent/memory-runtime`、`model/prompt`、`features/settings` 等）已写入各层 `AGENTS.md`，[main-process-layering.md](../../design/main-process-layering.md) §3 目录树可按需同期补全。 |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
| --- | --- | --- |
| 挪动前基线 `npm test` | 1129 个文件、14465 项通过 | 2026-11-12 |
| 第一次挪动后 `npm test`（`8da58c2`） | 6 个文件 17 项失败，均为路径问题，已修复并单独重跑通过 | 2026-11-12 |
| 三端类型检查 | main、preload、renderer 均通过（`0` 诊断） | 2026-11-13 |
| PR `#57` 合并前 `npm test` | 1131 个文件中 1129 通过、1 跳过；1 个文件因测试替身缺少新导出而加载失败，补上后单独重跑通过（27 项） | 2026-11-13 |
| PR `#58`（H–K）分域回归 | `memory` / `memory-runtime` / `app` / `rag`（193 文件）；`agent` / `features` / `app` / `tooling`（356 文件、4637 项）及三端 `tsc`、存储边界检查均通过 | 2026-11-13 |
| `npm run build` / 开发版启动 | 均通过（隔离数据目录下启动无报错） | 2026-11-13 |
| 运行级真机验证（模型运行、打包版） | **待做**（未执行） | — |

## 5. 守护规则（`src/main/layering.test.ts` + `src/main/layers.json`）

1. **只许向下/同层引用**：`src/main` 各层只能引用自己所在层和 `layers.json` 中 `allow` 列出的更低层，不得向上越层。
2. **禁止例外清单绕过**：所有越层/测试辅助文件引用违规必须直接清零，不设存量白名单。
3. **生产不引测试文件**：`src/main` 生产代码不得引用 `*.test.*`、`*.acceptance.*`、`*.test-support.*` 或 `testing/` 目录文件。
4. **全目录登记**：`src/main` 下的每个一级目录都必须在 `layers.json` 中显式声明归属层。
5. **层内子模块定序**：`layers.json` 中配有 `internal` 的层（当前为 `memory` 与 `agent`）严格限制下组不得引用上组，且 `internal` 列表中的目录名必须真实存在且不重复。

## 6. 偏离计划

- 计划里把越层引用分成“类型下沉 / 文件归属 / 启动时注入”三个施工包（E、F、G）。实际发现绝大多数可以靠挪文件解决，于是按“先挪文件、再动代码”的顺序连续完成，没有按包拆 PR。合并时可以按上表的提交顺序拆成 PR。
- `tooling` 允许引用 `model`（工具 schema 使用模型类型），已写入 `layers.json`。
- 新增了设计里没有列出的模块目录：`agent/memory-runtime`、`model/prompt`、`model/context`、`model/errors`、`model/queue`、`tooling/execution`、`base/lifecycle`、`conversation/channels`、`platform/schedule`、`features/settings`、`features/memory`、`features/music`、`knowledge/stickers`。各层 `AGENTS.md` 已写明职责；设计文档 §3 的目录树需要同步。
