# 主进程分层施工进度

状态：施工中（越层引用已清零；全量测试通过；开发版启动已验证，运行级真机验证未做）
施工计划：[2026-11-12-main-process-layering.md](./2026-11-12-main-process-layering.md)
设计：[docs/design/2026-11-12-main-process-layering.md](../../design/2026-11-12-main-process-layering.md)

本文是交接入口。换会话或换人时先读这里，再读施工计划。

## 1. 当前状态

- 工作区：`E:\Codex\Firefly\firefly-layering`，分支 `refactor/main-layering`（基于 `dev/firefly-1.2.0` 的 `3ef7862`），未推送、未合并。
- `src/main` 已按十个层目录组织；`src/main/layering.test.ts` 检查全部引用方向，越层引用为 0，没有例外清单。
- 分析与挪动脚本在 `E:\Codex\Firefly_Agent-skills-layout\output\audit-1.2.0\`（不在仓库里）：`deps.cjs`、`move.cjs`、`move2.cjs`、`rules-layers.json`、各批 `moves-*.json`、`gen-known.cjs`、`gen-agents.py`。

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

行为相关的改动只有三处，都是把“下层直接引用上层”改成“上层传入或登记”，对外行为不变：
1. `createRunAdjustmentPoller` 的存储参数从“默认会话存储”改为必传（唯一的生产调用方原本就显式传入）。
2. `selectCachedHistoryCoverage` 改为接收会话 id 读取函数（组合根传入）。
3. 检索模块通过登记的 `UserMemoryRecallSource` 访问早期记忆库；没有登记时用户记忆检索返回空，与原来“记忆库加载失败时返回空”一致。登记在 `app/default-dependencies.ts` 引入 `memory/legacy/rag-recall-source.ts` 时完成。

## 3. 未完成项

| 项 | 说明 |
|---|---|
| B4 真机验证（剩余） | 已做：`npm run build` 通过，用隔离数据目录启动开发版，启动日志无报错，聊天、桌宠、提醒三个窗口正常。未做：配置模型后各跑一次 Chat / Work / Code；设置窗口、插件面板、截图、音乐脚本；打包版 |
| H 记忆内部分层 | `memory/core` 仍引用上层子库（`repository.ts` 聚合 5 个子库）；在 `layers.json` 里给 `memory` 加内部顺序后清理 |
| I 智能体运行内部 | `agent/runtime`、`agent/loop`、`agent/tools`、`agent/memory-runtime` 之间互相引用，需定方向；`agent/loop` 的 Harness* 类型和函数名改为 AgentLoop* |
| J 文件级循环 | `memory/legacy/obsidian-exporter ↔ memory-store`；`ChatMessageList ↔ StreamdownMessageContent` |
| K 死代码 | 约 17 个只有测试引用的文件逐个确认后删除 |
| 文档路径 | 7 份功能施工计划和 `docs/` 其他文档里的旧路径按挪动表批量替换 |
| 合并 | 合回 `dev/firefly-1.2.0`（建议在 7 份计划格式改写都提交之后合，避免文档冲突） |
| 另行设计 | `src/renderer`、`src/preload/index.ts`、`src/plugins` 的整理（见设计文档 §8） |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| 挪动前基线 `npm test` | 1129 个文件、14465 项通过 | 2026-11-12 |
| 第一次挪动后 `npm test`（`8da58c2`） | 6 个文件 17 项失败，均为路径问题，已修复并单独重跑通过 | 2026-11-12 |
| 三端类型检查 | main、preload、renderer 均通过 | 2026-11-13 |
| 最终 `npm test` | 1131 个文件中 1129 通过、1 跳过；1 个文件因测试替身缺少新导出而加载失败，补上后单独重跑通过（27 项）。补丁之后没有再跑一次全量 | 2026-11-13 |
| `npm run build` | 通过 | 2026-11-13 |
| 开发版启动 | 隔离数据目录下启动正常，日志无报错 | 2026-11-13 |
| 存储边界、插件 schema | 通过 | 2026-11-12 |
| 运行级真机验证（模型运行、打包版） | 未做 | — |

## 5. 偏离计划

- 计划里把越层引用分成“类型下沉 / 文件归属 / 启动时注入”三个施工包（E、F、G）。实际发现绝大多数可以靠挪文件解决，于是按“先挪文件、再动代码”的顺序连续完成，没有按包拆 PR。合并时可以按上表的提交顺序拆成 PR。
- `tooling` 允许引用 `model`（工具 schema 使用模型类型），已写入 `layers.json`。
- 新增了设计里没有列出的模块目录：`agent/memory-runtime`、`model/prompt`、`model/context`、`model/errors`、`model/queue`、`tooling/execution`、`base/lifecycle`、`conversation/channels`、`platform/schedule`、`features/settings`、`features/memory`、`features/music`、`knowledge/stickers`。各层 `AGENTS.md` 已写明职责；设计文档 §3 的目录树需要同步。
