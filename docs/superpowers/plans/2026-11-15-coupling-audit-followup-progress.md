# 耦合审查遗留项施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-coupling-audit-followup.md](./2026-11-15-coupling-audit-followup.md)

## 1. 当前状态

- 分支：`feat/coupling-r1`（基于 `docs/coupling-followup-plan`）
- 进行到：施工包 R1 完成

## 2. 已完成项

| 任务 | 改动 | 验证 |
|---|---|---|
| R1.1 音乐面板的类型 | 新增 `src/shared/process-boundary.test.ts`：渲染进程与 preload 的生产代码不得引用 `src/main`。先跑失败，正好报出 `qqmusic-panel.ts` 与 `preload/music.ts` 两处（审查时只发现渲染进程那处）。三个类型移到 `src/shared/qqmusic-types.ts`；主进程服务从那里引入并转出，`features/music/bootstrap.ts` 不用改 | 边界、分层与音乐相关测试 23 项通过；main / preload / renderer 类型检查通过 |
| R1.2 渲染进程测试引用主进程 | 3 个测试都保留：`agent-routing.test.ts`、`presets.test.ts`、`timezone-options.test.ts` 核对的是设置页的选项与主进程实际行为是否一致（例如设置页给出的每个时区，主进程都接受），本来就需要同时引用两边。边界检查只管生产代码 | — |

## 3. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| R1：`npx vitest run src/shared/process-boundary.test.ts src/main/layering.test.ts src/renderer/settings/music src/main/platform/music src/main/features/music` | 23 项通过 | 2026-11-15 |
| R1：三端类型检查 | 通过 | 2026-11-15 |

## 4. 偏离计划

- R1.1 的检查同时覆盖 preload，多发现 `preload/music.ts` 一处，一并修掉。
- R1.2 计划写的是"逐个看，要么移逻辑要么挪测试"，实际 3 个都是跨进程一致性测试，保留原样。
