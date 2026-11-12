# L0 基础（`src/main/base`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：与业务无关的基础设施：文件与存储、日志、应用身份和数据目录、IPC 注册、提示词文件加载。
- **不负责**：任何“对话”“模型”“记忆”“工具”概念；不引用其他任何层。

## 引用规则

- 可以引用：本层内部，以及 无（最底层）。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 模块

| 目录 | 职责 |
|---|---|
| `identity/` | 应用身份、运行档案（production / dev / test / smoke）和数据目录的确定。数据目录、单实例、安装身份的改动先开 Issue。 |
| `ipc/` | IPC 注册范围（`ipc-scope.ts`）：各模块注册通道时用它统一登记和清理。 |
| `lifecycle/` | 启动就绪状态与退出协调（`readiness.ts`、`shutdown.ts`）。 |
| `logging/` | 日志输出与调试开关。 |
| `prompts/` | 提示词文件的定位与加载。 |
| `runtime-policy/` | 各阶段的超时与预算策略。 |
| `security/` | 安全相关的回归测试（依赖补丁、Git 配置等）。 |
| `storage/` | 存储上下文、原子写、设置文件、内容清单；所有落盘路径从这里取。 |
| `utils/` | 通用小函数（取消信号、规范化 JSON 等）。 |

## 验证

- 最近的测试：`npm test -- src/main/base`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
