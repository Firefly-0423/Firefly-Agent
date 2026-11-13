# L2 会话记录（`src/main/conversation`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：对话的权威记录：记录的类型、存储和结算；以及渠道消息的公共类型。
- **不负责**：怎么生成回复、怎么执行工具。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。没有例外清单：出现越层引用测试就失败。

## 模块

| 目录 | 职责 |
|---|---|
| `channels/` | 外部渠道的公共类型（`channel-types.ts`）、适配器基类和消息文本格式，供记忆、运行和功能层共用。 |
| `transcript/` | 会话记录的类型、存储（`conversation-transcript-store.ts`）、分发协调与结算（含 `run-settlement.ts`）。把记录接进运行的部分（写入口、上下文物化）在 `agent/loop`。持久化格式的改动先开 Issue。 |

## 验证

- 最近的测试：`npm test -- src/main/conversation`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
