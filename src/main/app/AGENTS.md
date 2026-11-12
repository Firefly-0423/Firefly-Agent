# L6 组合根（`src/main/app`）

通用约定见仓库根目录 `AGENTS.md`，开发流程见 `docs/contributing/development-workflow.md`。本文只写这一层特有的规则。

## 职责

- **负责**：创建各模块并注入依赖，决定启动与退出的顺序。`src/main/index.ts` 是进程入口。
- **不负责**：业务逻辑。其他层不引用本层。

## 引用规则

- 可以引用：本层内部，以及 `base`、`platform`、`model`、`tooling`、`conversation`、`knowledge`、`memory`、`agent`、`features`。
- 不能引用更高的层，类型引用也不行。上层的东西要用时，让上层在启动时传进来（函数或接口），或者把共用类型下沉。
- 规则由 `src/main/layering.test.ts` 检查，层级表在 `src/main/layers.json`。存量违规记在 `src/main/layering-known-violations.json`，这份清单只能减少：修掉一条就删掉一条，不能新增。

## 文件

本层没有子目录：`application.ts`、`default-dependencies.ts`、各阶段的 `*-bootstrap.ts`、`shutdown.ts` 等装配文件直接放在这里。

## 验证

- 最近的测试：`npm test -- src/main/app`
- 依赖方向：`npm test -- src/main/layering.test.ts`
- 类型检查：`npm run build:main`（或 `npx tsc -p tsconfig.main.json --noEmit`）
- 涉及落盘路径时：`npm run check:storage-boundary`

## 施工文件

- 分层设计：`docs/design/2026-11-12-main-process-layering.md`
- 施工计划与进度：`docs/superpowers/plans/2026-11-12-main-process-layering.md` 及同名 `-progress.md`
- 本层的功能施工计划在 `docs/superpowers/plans/` 下，开工前在这里补上链接。
