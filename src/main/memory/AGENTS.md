# L3 记忆（`src/main/memory`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：记忆的提取、存储、召回，以及每轮对话的上下文组装。
- **不负责**：运行循环、渠道、会话窗口。需要这些信息时由上层传入。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`、`tooling`、`conversation`、`knowledge`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。没有例外清单：出现越层引用测试就失败。

## 模块

| 目录 | 职责 |
|---|---|
| `context/` | 上下文仓库、预算、附件投影、会话权威等记忆侧的上下文能力。把记忆接进一次运行的部分在 `agent/memory-runtime`。 |
| `core/` | 记忆库核心：仓库、事务、加密、worker。最底层，不引用其他记忆子模块（存量违规见清单）。 |
| `history/` | 历史（H）库：读取、索引、排序。 |
| `legacy/` | 早期记忆库与 Obsidian 导出；通过 `rag-recall-source.ts` 把自己登记给检索模块。 |
| `policy/` | 事实与偏好的提取和裁决策略。 |
| `recall/` | 召回与事实选择。 |
| `shadow/` | 影子评估。 |
| `sources/` | 记忆来源（桌面用户、原生历史等）与来源登记。 |

## 验证

- 最近的测试：`npm test -- src/main/memory`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
