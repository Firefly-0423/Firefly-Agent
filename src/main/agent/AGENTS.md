# L4 智能体运行（`src/main/agent`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：一次运行的全过程：组装提示词与上下文、调用模型、调度并执行工具、伙伴委派、MCP、后台模型任务。
- **不负责**：窗口、渠道、定时触发、会话列表。这些属于 `features`。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`、`tooling`、`conversation`、`knowledge`、`memory`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 模块

| 目录 | 职责 |
|---|---|
| `loop/` | 运行循环（agent loop）：模型轮次、工具调度、压缩、恢复、运行存档。运行终态、取消 / 超时 / 错误的区分、重试策略的改动先开 Issue。目录已从 harness 改名，类型和函数名的改名按 1.2 规格另行进行。 |
| `mcp/` | MCP 接入与管理。 |
| `review/` | 工作区改动审查。 |
| `runtime/` | 运行入口（`agent-runtime.ts`、`firefly-agent.ts`、`chat-loop.ts`）、提示词与上下文组装、伙伴会话、计划模式。 |
| `sandbox/` | 命令沙箱。 |
| `services/` | 后台模型客户端、向量索引服务等。 |
| `tasks/` | 伙伴会话注册与任务人设。 |
| `tools/` | 内置工具及其登记（`tool-registration.ts`）、命令执行策略。新增工具（尤其写文件、执行命令、联网）先开 Issue。 |

## 验证

- 最近的测试：`npm test -- src/main/agent`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
