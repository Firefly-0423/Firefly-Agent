# L5 功能入口（`src/main/features`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：把能力接到用户面前：聊天窗口桥接、会话存储与会话 IPC、外部渠道、定时任务、主动聊天、插件、诊断入口。
- **不负责**：装配（属于 `app`）。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`、`tooling`、`conversation`、`knowledge`、`memory`、`agent`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 模块

| 目录 | 职责 |
|---|---|
| `channels/` | 外部聊天渠道（QQ / 飞书等）的适配器、准入与策略。外部消息的模式和工具范围改动先开 Issue。 |
| `chat/` | 聊天窗口与运行之间的桥接（AG-UI 事件）。事件顺序的改动先开 Issue。 |
| `diagnostics/` | 诊断与仿真入口，不随安装包运行。 |
| `memory/` | 记忆管理界面的 IPC。 |
| `music/` | 音乐工具的登记与冒烟入口。 |
| `plugins/` | 插件宿主（host）与插件面板（panel）。清单字段、能力、生命周期和隔离边界的改动先开 Issue。 |
| `proactive/` | 主动聊天。 |
| `scheduler/` | 定时任务的存储、引擎与 IPC。 |
| `sessions/` | 会话存储、待发队列和会话相关 IPC。 |
| `settings/` | 设置窗口的 IPC 与通用设置生效流程。 |

## 验证

- 最近的测试：`npm test -- src/main/features`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
