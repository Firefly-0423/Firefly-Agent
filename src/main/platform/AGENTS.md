# L1 平台服务（`src/main/platform`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：桌面平台能力和与用户交互的通道：设置、权限与审批、窗口、提醒、更新、截图、语音、浏览器、Git、音乐、贴纸。
- **不负责**：模型调用、会话内容、记忆、运行循环。这些能力不知道“一次对话”是什么。

## 引用规则

- 可以引用：本层内部，以及 `base`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 模块

| 目录 | 职责 |
|---|---|
| `browser/` | 浏览器控制与代理。 |
| `git/` | Code 模式的 Git 服务与 IPC。 |
| `interaction/` | 向用户提问（`user-choice.ts`、`ask-card.ts`）和提醒事件（`toast-events.ts`）。 |
| `lsp/` | 语言服务客户端。 |
| `music/` | 音乐服务。 |
| `permission/` | 权限档位（只读 / 请求审批 / 完全访问）与审批流程。任何放宽权限的改动先开 Issue。 |
| `protocols/` | 自定义协议注册。 |
| `screenshot/` | 截图助手的生命周期与调用。 |
| `settings/` | 通用设置、设置门面和设置窗口的 IPC。（模型档案相关文件按设计要迁到 `model/config`，设置 IPC 要迁到 `features`，见存量违规清单。） |
| `speech/` | 语音识别（asr）、音频播放（audio）和对应服务封装（mossland）。 |
| `stickers/` | 贴纸资源与向量。 |
| `toast/` | 提醒窗口。 |
| `updater/` | 应用更新。 |
| `windows/` | 窗口创建、状态与激活请求。 |

## 验证

- 最近的测试：`npm test -- src/main/platform`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
