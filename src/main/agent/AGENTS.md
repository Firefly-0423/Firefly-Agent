# L4 智能体运行（`src/main/agent`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：一次运行的全过程：组装提示词与上下文、调用模型、调度并执行工具、伙伴委派、MCP、后台模型任务。
- **不负责**：窗口、渠道、定时触发、会话列表。这些属于 `features`。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`、`tooling`、`conversation`、`knowledge`、`memory`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。没有例外清单：出现越层引用测试就失败。

## 层内顺序

`src/main/layers.json` 规定了本层子模块的顺序（低 → 高）：`services` / `tasks` / `sandbox` / `mcp` → `review` / `tools` → `loop` → `memory-runtime` / `runtime`。低的模块不能引用高的模块，同一组内可以互相引用；由 `src/main/layering.test.ts` 检查。

## 模块

| 目录 | 职责 |
|---|---|
| `loop/` | 运行循环（agent loop）：模型轮次、工具调度、压缩、上下文管理、执行台账、恢复、运行存档，以及会话记录的写入口和上下文物化。对上层只通过 `run-ports.ts` 里的接口（运行设置与事件、记忆运行、委派范围、伙伴执行请求）。运行终态、取消 / 超时 / 错误的区分、重试策略的改动先开 Issue。入口是 `agent-loop.ts` 的 `runAgentLoop`（原 Harness，1.2 规格第 0 部分改名）。 |
| `mcp/` | MCP 接入与管理。 |
| `memory-runtime/` | 把记忆接进一次运行：记忆运行时、各入口的接入（桌面、渠道、后台）、运行捕获、会话记录适配、模型计数。 |
| `review/` | 工作区改动审查。 |
| `runtime/` | 运行入口（`agent-runtime.ts`、`firefly-agent.ts`、`chat-loop.ts`）、运行与循环之间的适配器（`adapter/`）、受控响应、运行输入类型、伙伴会话、排队消息插入（`pending-adjustment.ts`）。 |
| `sandbox/` | 命令沙箱。 |
| `services/` | 后台模型客户端、向量索引服务等。 |
| `tasks/` | 伙伴会话注册与任务人设。 |
| `tools/` | 内置工具及其登记（`tool-registration.ts`，含早期记忆工具 `legacy-memory-tools.ts`）、命令执行策略、计划模式、校验运行器。新增工具（尤其写文件、执行命令、联网）先开 Issue。 |

## 验证

- 最近的测试：`npm test -- src/main/agent`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
