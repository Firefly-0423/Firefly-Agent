# 测试入口与覆盖清单

状态为工程参考，核对日期 2026-11-14，维护者 hotaru。

## 入口与集合

| 入口 | 测试集合 | 前提 | CI 位置与证据 |
|---|---|---|---|
| `npm test` | vitest.config.ts 的七组 include | 安装依赖，Git Bash；原生用例需对应 helper | test.yml 的 Run full test suite 通过 scripts/ci/run-vitest.ps1 无文件参数运行 Vitest |
| `node --test "scripts/**/*.test.mjs"` | 下表 26 个文件，含 eval 与 marketplace | Node 24 CI，依赖与合成临时目录 | test.yml 的 Run Node script tests，失败日志随现有 evidence artifact 上传 |
| `npm run test:memory-history-zero-write` | 1 个独立 acceptance 文件，12 项 | Windows 本地 NTFS、独立根与 TEMP/TMP 相同、debug/release history-read helper | test.yml 的 Run native memory history zero-write acceptance，在已有 release helpers 构建后显式构建 debug helper |
| `npm run test:plugin-examples` | scripts/plugin-sdk/test-examples.mjs 从打包 SDK 编译和冒烟示例 | check:plugin-sdk 生成可用包 | plugin-sdk.yml 的 Compile and smoke-test plugin examples |
| 两条 workspace Cargo 测试 | workspace_handle_contract、lib workspace_access | Windows，本地 NTFS，FF_WORKSPACE_TEST_ROOT | test.yml 的 Build workspace helper and run its native tests |

默认 Vitest 路径为 `src/plugins/**/*.test.ts`、`src/main/**/*.test.ts`、`src/renderer/**/*.test.ts`、`src/shared/**/*.test.ts`、`src/cli/**/*.test.ts`、`skills/**/tests/**/*.test.ts`、`plugin-sdk/src/**/*.test.ts`。独立 acceptance 使用 `scripts/testing/vitest.memory-history-zero-write.config.ts`，不匹配这些默认路径。

Node 24 官方测试运行器文档提供带引号的 glob 示例，本次命令直接传给 Node，避免 Shell 展开差异。本机 Node 26.13.1 实际发现下表 26 个文件。CI 仍固定 Node 24，Node 24 的实跑发现集合尚待远端验证。本机不据此声称 Node 24 已通过。

- [Node 24.0.0 官方测试运行器文档](https://github.com/nodejs/node/blob/v24.0.0/doc/api/test.md#running-tests-from-the-command-line)

## Node 文件逐项归属

所有下列文件均归属 test.yml 的 Run Node script tests。eval 与 marketplace 专用脚本用于本地选跑，test.yml 无重复步骤。

| 文件 | 集合 |
|---|---|
| `scripts/build/history-helpers.test.mjs` | Node 内置测试运行器 |
| `scripts/build/workspace-helper.test.mjs` | Node 内置测试运行器 |
| `scripts/ci/ci-timing.test.mjs` | Node 内置测试运行器 |
| `scripts/ci/trace-worker-process.test.mjs` | Node 内置测试运行器 |
| `scripts/dev/launch-electron.test.mjs` | Node 内置测试运行器 |
| `scripts/eval/memory-history/dataset.test.mjs` | Node 内置测试运行器 |
| `scripts/eval/memory-history/metrics.test.mjs` | Node 内置测试运行器 |
| `scripts/packaging/electron-builder-config.test.mjs` | Node 内置测试运行器 |
| `scripts/packaging/prepare-mingit.test.mjs` | Node 内置测试运行器 |
| `scripts/packaging/prepare-mpv.test.mjs` | Node 内置测试运行器 |
| `scripts/packaging/validate-skills.test.mjs` | Node 内置测试运行器 |
| `scripts/packaging/xlsx-workspace.test.mjs` | Node 内置测试运行器 |
| `scripts/perf/chat-renderer-recording.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/build.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/catalog-plugins.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/code-language.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/json-tools.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/text-stats.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/text-trim.test.mjs` | Node 内置测试运行器 |
| `scripts/plugin-marketplace/timezone-tools.test.mjs` | Node 内置测试运行器 |
| `scripts/testing/archive-reporter.test.mjs` | Node 内置测试运行器 |
| `scripts/testing/run-tests.test.mjs` | Node 内置测试运行器 |
| `scripts/verify/history-helpers.test.mjs` | Node 内置测试运行器 |
| `scripts/verify/memory-core/probe-result.test.mjs` | Node 内置测试运行器 |
| `scripts/verify/memory-core/probe-root.test.mjs` | Node 内置测试运行器 |
| `scripts/verify/storage-boundary.test.mjs` | Node 内置测试运行器 |

## 独立原生验收的可复现环境

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
npm run build:history-helpers
npm run build:workspace-helper
cargo build --locked --manifest-path native/Cargo.toml --features history-read --bin firefly-history-read
New-Item -ItemType Directory -Force output/docs-eng/native-root | Out-Null
$env:FF_HISTORY_TEST_ROOT=(Resolve-Path output/docs-eng/native-root).Path
$env:TEMP=$env:FF_HISTORY_TEST_ROOT
$env:TMP=$env:FF_HISTORY_TEST_ROOT
$env:FF_HISTORY_HELPER=(Resolve-Path native/target/debug/firefly-history-read.exe).Path
$env:FF_HISTORY_RELEASE_HELPER=(Resolve-Path native/target/release/firefly-history-read.exe).Path
npm run test:memory-history-zero-write
```

路径由本工作区实际构建产生。debug helper 包含取消屏障，release helper 验证忽略 debug 环境变量。缺少根目录时 suite 直接以 `EXPLICIT_WINDOWS_NTFS_SYNTHETIC_ROOT_REQUIRED` 失败；缺少 helper 以 `EXACT_SYNTHETIC_HELPER_REQUIRED` 失败。零项执行不会被登记为通过。CI 根位于 runner.temp 并只在该步骤设置 TEMP/TMP，不修改默认测试配置。

## Rust 覆盖范围与补跑条件

| 集合 | 当前 CI 归属或缺口 | 补跑入口与前提 |
|---|---|---|
| `workspace_handle_contract.rs` 与 `workspace_access/windows_tests.rs` | 当前 CI 两条命令覆盖 | `cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --test workspace_handle_contract -- --test-threads=1` 和 `--lib workspace_access -- --test-threads=1`，先创建 FF_WORKSPACE_TEST_ROOT |
| `history_read_contract.rs`、`history_read_session_contract.rs`、`history_presence_contract.rs` | CI 未接入 | `cargo test --locked --manifest-path native/Cargo.toml --features history-read --test history_read_contract --test history_read_session_contract --test history_presence_contract -- --test-threads=1`，既有 fixture 硬性要求 E 盘绝对根 FF_HISTORY_TEST_ROOT；不在无 E 盘运行器声称已跑 |
| `geometry_contract.rs`、`protocol_contract.rs`、`request_lifecycle.rs` | CI 未单独接入 | `cargo test --locked --manifest-path native/Cargo.toml --test geometry_contract --test protocol_contract --test request_lifecycle`，Windows 构建环境 |
| `display_contract.rs`、`capture_gdi_smoke.rs` | CI 未接入 | 同 Cargo `--test` 指定文件名，需要实际 Windows 显示器与图形会话 |
| `helper_capture_interaction.rs`、`helper_delivery.rs`、`helper_diagnostics.rs`、`helper_process_lifetime.rs` | CI 未接入 | 各自 `cargo test --locked --manifest-path native/Cargo.toml --test <文件名去掉.rs> -- --test-threads=1`，需要运行截图 helper、图形桌面，部分操作涉及剪贴板和窗口交互，须在独立验收环境执行 |
| lib 中其他单元测试 | 当前 CI 的 workspace_access 过滤器以外未覆盖 | `cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --lib -- --test-threads=1`，先逐项核对历史根、Windows/NTFS 和系统交互要求 |
| `tests/support/` | 共享 fixture 模块，随调用方执行 | 无独立测试入口 |

这些命令列明补跑归属，执行结果以进度文档为准。现有 CI 命令没有覆盖全部原生测试。

## 触发范围与失败证据

test.yml 的 push 保留 main、firefly-demo 并增加 `dev/**`。pull_request 仍匹配 main 与 firefly-demo。`feat/docs-eng` 的直接 push 不匹配此次批准的 dev 模式。SDK 示例复用 plugin-sdk.yml，push / pull_request 均仅匹配 main、firefly-demo，直接 push 到 dev 分支不会运行该独立工作流。

Node 步骤通过 Tee-Object 保存输出并显式 `exit $LASTEXITCODE`，独立验收同样传播退出码。已有 always() evidence 上传步骤会保留两者日志。原默认 Vitest include、timeout、worker、审计 continue-on-error 与审计 artifact 均沿用基线。

2026-11-14 在现有 run-tests.test.mjs 临时把真实断言期望 run 改错，测试退出 1 并保存诊断，恢复原始字节后 2 项通过、退出 0。此为本地失败传播实验。远端工作流失败实验、恢复运行与 dev push 触发验收仍待负责人提交和推送后执行。

## 本次运行与待办

- Node 全集 191 项，188 通过、2 失败、1 跳过。失败为打包测试旧音乐路径和 probe-root.test.mjs 硬编码另一工作区。probe-root.ts 本身也固定该历史工作区授权边界，不能通过只换测试 cwd 安全恢复。按任务范围登记待单独处理。
- 原生零写入验收缺前提时退出 1、0 用例执行。具备前提时 12 项实际执行，11 通过、1 失败，valid 捕获期望 captured，实际 coverage-insufficient。保留断言供独立任务定位来源证明契约。
- 默认全量 14431 项通过、1 项失败、11 项跳过。失败为 pr-workflow.test.ts 的旧 push 分支精确期望与 D4 冲突，处理方式待负责人确认。
- 安装包、真实渠道、完整远端 CI 和 Node 24 尚未验收，详见施工进度。

- [施工进度与完整验证结果](../superpowers/plans/2026-11-12-docs-and-engineering-progress.md)
