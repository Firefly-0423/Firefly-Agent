# L2 工具契约（`src/main/tooling`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：工具“长什么样、怎么注册、怎么校验”的契约：注册表、工具上下文、参数校验、结果归一。
- **不负责**：任何具体工具的实现（内置工具在 `agent/tools`）；不直接调用记忆、检索等上层模块。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 模块

| 目录 | 职责 |
|---|---|
| `registry/` | 工具注册表、`ToolContext`、工具调用类型（`tool-call-types.ts`）、参数校验、执行器与结果归一。工具参数和返回格式的契约改动先开 Issue。 |

## 验证

- 最近的测试：`npm test -- src/main/tooling`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
