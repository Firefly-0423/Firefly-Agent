# L2 模型接入（`src/main/model`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：把一次请求发给模型并拿回结果：厂商适配、请求与重试、流式解析、结构化输出、模型档案与能力、图片转述。
- **不负责**：工具执行、记忆、运行循环、会话存储。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。没有例外清单：出现越层引用测试就失败。

## 模块

| 目录 | 职责 |
|---|---|
| `config/` | 模型档案（`model-settings.ts`）、模型目录、伙伴模型路由、连接状态、能力声明。 |
| `context/` | 一次请求的上下文契约（`context-contracts.ts`）：请求身份、预备请求、上下文错误。 |
| `errors/` | 运行错误类型（`agent-runtime-error.ts`），模型层及以上共用。 |
| `prompt/` | 提示词分层与缓存指纹（`prompt-layers.ts`）、内部记录消息（`internal-transcript.ts`）。提示词分层的改动先开 Issue。 |
| `providers/` | 各厂商接口适配（Anthropic / OpenAI / Responses 等）、请求准备、重试与看门狗、流式解析。重试策略和接口契约的改动先开 Issue。 |
| `queue/` | 后台模型任务队列（`llm-queue.ts`）。 |
| `structured/` | 结构化输出的运行与校验。 |
| `text/` | 模型文本处理：时间上下文、思考内容过滤、流式文本工具。 |
| `vision/` | 图片转述（`vision-captioner.ts`）与图片路由。 |

## 验证

- 最近的测试：`npm test -- src/main/model`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
