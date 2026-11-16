# 开发流程规范确立与文档/CI 工程治理

状态：流程文档、Node 24+ 支持、1.2.0 独立数据目录、三端指南/中英文免责声明与 CI 入口扩张已合并；远端 CI 触发、真实账号与打包验收待执行  
日期：2026-11-12（`development-workflow.md` 提交日与文档/工程计划确立日）

## 为什么做

1. **缺乏统一贡献与分包验收标准**：协作进入多智能体并行与细粒度 PR 阶段后，需要统一“设计/规格 → 施工计划 → 进度交接 → 单包 PR → 文档归档”流程与 PR 粒度（提交 `5bc54ac`）。
2. **文档、渠道风险披露与测试覆盖盲区**（`docs/superpowers/plans/2026-11-12-docs-and-engineering.md`）：
   - 缺少独立的免责声明及飞书/QQ/QQ Bot 用户配置指南，部分设置界面提示与真实代码边界不符；
   - 26 个 `scripts/**/*.test.mjs` Node 测试与原生历史零写入验收测试虽已存在于仓库，却未接入 `.github/workflows/test.yml`，导致脚本失效与路径漂移长期未在 CI 暴露；
   - `test.yml` 未触发 `dev/**` 分支推送，且 1.2.0 需要切换到与 1.1.x 隔离的数据目录 `%APPDATA%\Firefly-1.2.0`。

## 改了什么（前后结构对照）

| 领域 | 治理前 | 治理后 |
| --- | --- | --- |
| **研发流程规范**（`5bc54ac`） | 仅靠 `AGENTS.md` 局部约定，无统一文档目录分类、PR 拆分规范与交接进度模板 | 建立 `docs/contributing/development-workflow.md`（定义 `design`/`specs`/`plans`+`-progress`/`internal-issue`/`references`/`user-guide` 规范、单包 PR 原则与 Issue 先行原则），同步建立 `.github/CONTRIBUTING.md`、更新 `.github/pull_request_template.md` 与 `AGENTS.md` |
| **运行环境与数据目录**（PR `#61`、`#62`） | `engines` 与 Vitest 未兼容 Node 25+ 内置 `localStorage` 冲突；正式数据目录仍指向 `%APPDATA%\Firefly` | PR `#61` 支持 Node 24+ 并在 `vitest.config.ts` 按版本传入 `--no-experimental-webstorage`；PR `#62` 新增 `src/main/base/identity/data-directory.ts`（`FIREFLY_DATA_DIRECTORY = "Firefly-1.2.0"`），更新 `build/installer.nsh` 与验证脚本/README 不再使用 1.1.x 目录，同时修正 `electron-builder-config.test.mjs` 的旧音乐脚本路径 |
| **免责声明与渠道指南**（PR `#63`） | 无独立免责声明与渠道配置指南；设置界面 7 处渠道提示含与代码矛盾表述（如宣称 QQ 官方协议“零封号风险”等） | 新增 `docs/disclaimer.zh-CN.md` / `en.md`（打入 `electron-builder.yml` `extraResources`）与 `docs/user-guide/{index,feishu,napcat-onebot,qqbot-official}.md`；补齐三渠道适配器单测（22 文件 214–215 项）；核查并修正 `zh-CN.json` 与 `index.html` 7 处渠道提示及对应渲染测试 |
| **CI 覆盖矩阵扩展**（PR `#63`） | `.github/workflows/test.yml` 不跑 `scripts/**/*.test.mjs` 与 `test:memory-history-zero-write`，`push` 不触发 `dev/**`；`probe-root` 测试固定另一工作区 | 制定 `docs/engineering/test-coverage-map.md`（登记 7 组 Vitest、26 个 Node 测试文件、Rust 入口与独立验收前提）；`test.yml` 补充 `Run Node script tests`、`Run native memory history zero-write acceptance` 与 `"dev/**"` 推送触发；修复 `scripts/verify/memory-core/probe-root.ts`（`isProbeWorkspace`）及 `native-history-zero-write.acceptance.ts` 来源夹具，并同步 `src/main/pr-workflow.test.ts` |

## 怎么验证的

1. **三端类型检查与构建**（`2026-11-12-docs-and-engineering-progress.md` §收尾复验）：`tsc -p tsconfig.{main,preload,renderer}.json --noEmit`、`npm run check:storage-boundary`（79 个许可访问点 / 43 文件）、`npm run check:plugin-schema`、`npm run build` 均退出 0。
2. **渠道与界面测试**：channels 专题 22 文件 215 项通过；设置页 channels/i18n 6 文件 49 项通过，并在 `FIREFLY_ISOLATION_ROOT` 隔离开发版实际确认 7 处新文案呈现。
3. **Node 脚本、原生与全量测试**：`node --test "scripts/**/*.test.mjs"` 修正 `probe-root`、`pr-workflow` 与音乐路径后达到 196 项 195 通过 1 跳过 0 失败；`npm run test:memory-history-zero-write` 12 项全通过；Cargo `workspace_handle_contract`（6 项）与 `workspace_access`（9 项）通过；`pr-workflow.test.ts` 6/6 通过。

## 涉及的 PR

- **提交 `5bc54ac`**（2026-11-12）：`docs: add the Firefly development workflow and contributing guide`（直提交确立流程规范）。
- **PR `#61`**（`5179f04`，2026-11-14）：`chore/node-24-plus`（Node 24+ 与 Vitest WebStorage 兼容）。
- **PR `#62`**（`ecdd9d8`，2026-11-14）：`feat/data-dir`（切换 1.2.0 正式目录至 `Firefly-1.2.0` 与安装器选项同步）。
- **PR `#63`**（`d2d1184`，2026-11-14）：`feat/docs-eng`（免责声明、渠道指南、工程测试覆盖表、风险登记表及 CI 扩面）。

## 遗留事项

1. **远端 Node 24 CI 实跑与触发验收**：进度文档记录本机使用 Node 26，Node 24 上 `node --test "scripts/**/*.test.mjs"` 发现集合、CI 失败日志保留实验及 `dev/**` push 自动触发仍待远端 CI 运行验证；`.github/workflows/plugin-sdk.yml` 仍未触发 `dev/**` 推送。
2. **安装包与真实渠道验收未执行**：完整安装包内 `resources/docs/` 免责声明核对、`%APPDATA%\Firefly-1.2.0` 打包版首次启动隔离与三渠道真实账号收发测试均待构建输入齐全后执行。
3. **文档同步与待定条目**（见已知问题 [disclaimer-pending-clauses-and-sync.md](../internal-issue/2026-11-16-disclaimer-pending-clauses-and-sync.md) 与 [channel-work-allow-all.md](../internal-issue/2026-11-16-channel-work-allow-all.md)）：第 ⑪ 条私密渠道与时限、第 ⑧ 条未成年人措辞、第 ⑤ 条目录文本对齐 PR `#62`，以及渠道 Work 收紧后的 B6 文档跟进。
