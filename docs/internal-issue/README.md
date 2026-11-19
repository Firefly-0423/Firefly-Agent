# Firefly 已知问题汇总

本目录记录 Firefly 1.2.0 开发、耦合审计、测试断言加固、回归验证与文档梳理过程中确认的已知问题与近期已修复记录。写作规范见 [development-workflow.md](../contributing/development-workflow.md)。

| 日期 | 问题 | 当前状态 | 详细记录 |
| --- | --- | --- | --- |
| 2026-11-19 | 项目旧会话有附件时新任务读取历史失败 | 已修复，待合并和打包复测 | [详细记录](./history-reader-rejects-attachments.md) |
| 2026-11-17 | 中断的运行重开后，“询问用户”等工具行仍显示“进行中” | 已修复（PR #100 / `94b397d` 已合并） | [interrupted-run-tool-rows-keep-waiting](./interrupted-run-tool-rows-keep-waiting.md) |
| 2026-11-16 | 运行中插入的补充在部分写入失败时丢失，或会话记录半截条目被重放 | 已修复（PR #97 / `23aa1f6` 已合并；真机造障未测） | [queue-insert-lost-or-replayed](./queue-insert-lost-or-replayed.md) |
| 2026-11-16 | 切换会话、刷新或关窗会取消正在进行的运行 | 已修复（PR #95 / `633eb36` 已合并） | [run-cancelled-on-switch-or-reload](./run-cancelled-on-switch-or-reload.md) |
| 2026-11-16 | 渲染页重载后，仍在等待的审批没有可处理的卡片 | 已修复（PR #93 / `ecbdfbd` 已合并） | [approval-lost-after-reload](./approval-lost-after-reload.md) |
| 2026-11-16 | 接管超时后旧运行仍占着会话守卫，界面侧停止状态与提示待补 | 已修复（Main 守卫 PR #91 / `dc6327a`；界面提示与暂停派发 PR #102 / `7c7aa49` 已合并；漏收事件时需手动重试，见详细记录） | [takeover-timeout-retains-guard](./takeover-timeout-retains-guard.md) |
| 2026-11-16 | 外部渠道私聊开启工具后采用 `work` 与 `allow_all` 直接执行 | 待修复（待渠道 Work 收紧落地后由 B6 跟进） | [channel-work-allow-all](./channel-work-allow-all.md) |
| 2026-11-16 | Chat 模式仍监听并允许延迟 Plan 事件 | 已修复，待合并 | [chat-deferred-plan-events](./chat-deferred-plan-events.md) |
| 2026-11-16 | 插件示例存在停止写回被清空及非 JSON 对象持久化缺陷，Mock 测试无法检出 | 待修复（已登记于 `examples/README.md`） | [plugin-example-mock-blindspots](./plugin-example-mock-blindspots.md) |
| 2026-11-16 | 旧版 `memory.json` 中 `l2DmaeStates` 含坏条目时按 ID 查找与更新会抛错 | 已决定延后（读取规范化已修 PR #71；坏条目抛错延后统一清理） | [l2-dmae-malformed-entries](./l2-dmae-malformed-entries.md) |
| 2026-11-16 | 设置页拆分发现的三项既有缺陷（`NAV_LABELS`、`MIMO_ICON_URL`、`settings.fetchModels`） | 已决定延后（待设置页拆分 PR 4 完成后独立修复） | [settings-post-split-bugs](./settings-post-split-bugs.md) |
| 2026-11-16 | 测试文件未被纳入任何 TypeScript 类型检查配置，Vitest 亦不做类型检查 | 待负责人决定 | [tests-excluded-from-typecheck](./tests-excluded-from-typecheck.md) |
| 2026-11-16 | 一次性诊断入口硬编码历史本机输出根目录 | 待负责人决定（PR #70 禁打包、PR #84 允许环境变量覆盖；默认值去留待定） | [diagnostic-hardcoded-root](./diagnostic-hardcoded-root.md) |
| 2026-11-16 | 部分错误与拒绝路径缺少稳定产品错误码 | 待负责人决定 | [missing-product-error-codes](./missing-product-error-codes.md) |
| 2026-11-16 | 免责声明占位条款待定及第 ⑤ 条数据目录描述滞后 | 待负责人决定 | [disclaimer-pending-clauses-and-sync](./disclaimer-pending-clauses-and-sync.md) |
| 2026-11-16 | Agent 终态持久化失败时误存空正文并错误发送已落盘回执 | 已修复（PR #90 / `4683aae`；真机造障未测） | [chat-terminal-save-failure](./chat-terminal-save-failure.md) |
| 2026-11-16 | `electron-builder-config.test.mjs` 主进程分层后仍断言旧音乐脚本路径 | 已修复（PR #62 / `ecdd9d8`、PR #63 / `d2d1184`） | [electron-builder-stale-music-path](./electron-builder-stale-music-path.md) |
| 2026-11-16 | `native-history-zero-write` 验收 `whole valid capture/query` 曾报 `coverage-insufficient` | 已修复（PR #63 / `d2d1184`） | [native-history-zero-write-fixture-gap](./native-history-zero-write-fixture-gap.md) |
| 2026-11-16 | `memory-core/probe-root` 验证测试曾硬编码外部工作区路径 | 已修复（PR #63 / `d2d1184`） | [probe-root-hardcoded-workspace](./probe-root-hardcoded-workspace.md) |
