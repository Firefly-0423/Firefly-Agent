# 记忆连续升级：mini 最新基线整合验收

## 范围与版本

- 目标：`firefly-mini-v1.1.x`，基线 `271f1dd5baf4a24939fdfe9c2c5d91d718cade11`。
- 受测整合 HEAD：`d22cff2d4ab45035c9fd89ddfdd197f90ae6df77`；本报告在验收后单独提交，不改产品代码。
- 分支：`codex/memory-upgrades-mini-20261018`，工作树 `E:\Codex\2026-10-17\task\firefly-memory-upgrades-pr`。
- 第一阶段已由 #109 合入。此次包含第二阶段恢复与显式同意后的保守 ADD、第三阶段明确时间区间召回、H 精确失效及候选安全确认；第四阶段混合检索和 Work/Code 扩展未实施。

原分支 `9f94f79b..6e60dd61` 的 22 个提交依赖顺序重放到新基线，`git range-diff` 全部为 `=`，另保留两项 H 验证文档提交。未覆盖原工作树或证据。发布前再次查询目标，仍为上述基线，未发现同名远端分支或重复开放 PR。Claude 的旧时间意图分支已包含在目标历史中，无未合入提交需要混入。

## 独立集成审查

独立 reviewer（gpt-6-astra / medium）只读核对整合差异与关键安全路径，没有阻塞或需另行修补的非阻塞发现：

- 基线交集只有设置页 HTML 和两份 i18n JSON；相对新基线仅增加记忆自动化容器及文案，其余 69 个上游变更完整保留。
- 没有 workflow、依赖清单/锁文件、发布配置、外部市场或设备模拟改动。
- 抽查逐步事务迁移、时间区间冲突、设置授权、派发前恢复权限、最终发送检查及 H 来源收据，未发现换基线导致权限放宽。
- 审查边界为整合和关键安全路径抽查，未逐行重审全部文件；reviewer 没有运行测试或访问真实资料。运行时证据如下。

## 新基线执行结果

| 检查 | 结果 |
| --- | --- |
| Main / preload / renderer TypeScript | 三项均 exit 0 |
| `node scripts/verify/storage-boundary.mjs` | 通过 |
| `node scripts/plugin-sdk/generate-schema.mjs --check` | 通过；仅 schema 一致性，不是 SDK 打包 |
| Vite 运行时构建 | 通过；保留既有大 chunk 警告 |
| `node scripts/testing/run-tests.mjs` 完整回归 | **886 files / 10932 cases 通过，0 失败；1 file / 11 cases 既有跳过；exit 0** |
| `scripts/verify/history-precise-electron.cjs` | **35 checks / 3 launches，0 失败** |
| `scripts/verify/candidate-panel-electron.cjs` | **17 checks / 3 launches，0 失败** |
| `git diff --check` | 通过 |

Electron 为真实应用、UI、preload、IPC、Worker、SQLite，但使用独立合成 profile 和 fake transport。实际请求验证：确认后冷重开新会话选入记忆；纠错后旧值消失；遗忘后再次冷重开无原文/旧记忆复活；纠错前无关历史及遗忘后有效新历史均可进入新请求。没有人工补 checkpoint。每次 owned 进程均记录正常退出。

全量和两次 Electron 的 2913 文件 manifest 一致，运行前后 SHA-256 均为 `18acb94658f73d06d93e8ccb2204f141a80e9e86a4b32cb161b41ea4e94f7657`，`sourceUnchanged=true`。原分支的历史结果不充当新基线结果。

## 失败记录与环境定位

首次新基线全量 `candidate-full-1792304444466-5a699547`：72 files 失败、814 files 通过；13 cases 失败、8790 通过、9 跳过。大量套件在 E 盘临时模块加载时 `ENOSPC`，会话 IPC 也在目录创建/文件写入时失败。当时 E 盘约剩 1.1 GB。失败记录完整保留，没有改产品、测试、超时或断言。

随后仅将整套运行的合成 profile、TEMP/TMP 和缓存移至有充足空间的 C 盘独立目录，同一完整入口通过，之前失败的会话 IPC 21/21 通过。没有并发运行 Electron 或删改用户资料。debug presence、debug history-read、release history-read 均复用已编译 helper，并核对与 H 工作树哈希一致；未重新构建 EXE。

本地证据保留于 `.verification/runs/`：

- `integration-build-1792304402496-279018a1`
- `candidate-full-1792304444466-5a699547`（失败）
- `candidate-full-1792305231572-e22e7fc7`（最终通过，941.28 秒）
- `candidate-electron-1792306202476-ddbd9c85`（H）
- `candidate-electron-1792306317291-c0719d1f`（候选）

C 盘运行的日志、manifest、结构化报告已复制回以上证据目录；合成临时数据仍在 `C:\Users\w1558\AppData\Local\Temp\firefly-memory-pr-runs`，不纳入 PR。实际 Electron 请求和截图位于 `.verification/electron-history-precise-1792306203268-414da1a1` 与 `.verification/electron-candidate-panel-1792306317987-18152599`。

## 迁移、回退和发布边界

schema 升至 v12，兼容读取旧事实；旧无来源凭据历史继续隔离，不自动重建。升级前必须备份数据库；旧二进制拒绝 v12，不能只 revert 代码。回退需停应用后恢复升级前备份，或另行实现并验证 down migration；恢复备份会失去备份后的写入。

真实 provider、付费模型、本地 SDK 打包和 EXE 安装包未验收；没有修改用户数据库或启动真实外部服务。本次 PR 可触发现有远端 Test 和 plugin-sdk CI，未改 workflow；package-windows 仅 workflow_dispatch，不触发。保留用户手动合并，不合并、不部署。
