# 设置页 `src/renderer/settings/settings.ts` 拆分重构

状态：进行中（设计、PR 1 拆前保护测试与 PR 2 壳层/路由/遗留胶水拆分已合并；PR 3、PR 4 及拆后修复 PR 尚未实施）  
日期：2026-11-15（设计文档与 PR 1–2 实施日）

## 为什么做

设计文档（`docs/design/2026-11-15-settings-page-split.md`）记录，传统设置窗口主文件 `src/renderer/settings/settings.ts` 膨胀至 1629 行，混合了外观/字体、聊天偏好、Firefly 贴纸与向量设置、模型档案/Presets/Custom Endpoint/测试连接/拉取模型、导航路由、窗口预览桥以及若干历史页面（Scheduler、Memory、Music）的孤儿事件胶水；而其余子页面已经完成模块化拆分，唯独入口超级模块持续承载跨模块逻辑。

为防止无测试直接搬移破坏既有表单提交与源码扫描契约，采用“先补 T1–T7 行为集成测试 → 拆壳层与遗留胶水 → 拆通用/偏好/外观面板 → 拆 API 面板 → 单独提 PR 修既小缺陷”的 4-PR 渐进方案。

## 改了什么（前后结构对照）

| 阶段 / PR | `settings.ts` 规模与职责 | 新增 / 改动结构与测试 |
| --- | --- | --- |
| **拆分前（PR #73 前基线）** | 1629 行，涵盖导航路由、`NAV_LABELS`、选项组辅助、头像/桌面提示音预览桥、Scheduler/Memory/Music 遗留绑定，以及通用、聊天偏好、Firefly、外观、API 全域逻辑 | 仅靠既有局部单测与 `default-dialogs-regression.test.ts` / `character-migration.test.ts` 保护，缺少表单保存与路由级集成测试 |
| **PR 1（PR `#78`，已合并）** | 业务代码零改动 | 按设计 §5.2 补齐 T1–T7 集成测试（共计 1987 行）：`api-fetch-models.integration.test.ts`、`api-test-connection.integration.test.ts`、`appearance-settings.integration.test.ts`、`firefly-panel.integration.test.ts`、`legacy-glue.integration.test.ts`、`preferences-channels.integration.test.ts`、`section-routing.integration.test.ts`，以及共用测试夹具 `settings-harness.test-support.ts` |
| **PR 2（PR `#87`，已合并，当前基线 `dc6327a`）** | `src/renderer/settings/settings.ts` 缩减至 **1332 行**，剥离壳层共享辅助与跨模块遗留胶水 | 新增：`src/renderer/settings/shared/preview-bridge.ts`、`src/renderer/settings/shared/option-group.ts`、`src/renderer/settings/shared/section-router.ts`；将对应遗留事件归位至 `src/renderer/settings/scheduler/panel.ts`、`memory/panel.ts`、`music/panel.ts`；新增 `settings-harness.test.ts`，并扩展 `default-dialogs-regression.test.ts` 与 `src/main/character-migration.test.ts` 的扫描覆盖范围 |
| **PR 3 与 PR 4（规划中，未开始）** | 目标是将 `settings.ts` 收敛为约 100 行的总装入口 | 计划拆出 `general/panel.ts`、`preferences/chat-panel.ts`、`preferences/firefly-panel.ts`、`appearance/panel.ts`（PR 3），以及 `api/endpoint-view.ts`、`api/fetch-models-controller.ts`、`api/profile-draft.ts`、`api/panel.ts`（PR 4） |

## 怎么验证的

1. **PR 1 测试先写锁基线**：新增 T1–T7 共 7 个 `*.integration.test.ts` 覆盖外观与字体取消保护、聊天偏好与渠道状态联动、Firefly 保存、`testActiveConnection` 超时校验、并发 `fetchModels` 过期响应丢弃、分区路由懒加载与卸载、以及 Memory/Scheduler 二次确认与条件字段展示。
2. **PR 2 纯重构零行为变更校验**：PR `#87` 合入时同步更新 `default-dialogs-regression.test.ts` 与 `src/main/character-migration.test.ts`，并新增 `settings-harness.test.ts` 与局部改动后的 `api-test-connection.integration.test.ts`，保持 `npm run check:renderer` 与设置页测试通过。

## 涉及的 PR

- **PR `#73`**（`7403ddb`，2026-11-15）：`docs/split-design-settings`（定稿 `docs/design/2026-11-15-settings-page-split.md`）。
- **PR `#78`**（`72150af`，2026-11-15）：`feat/settings-split-tests`（settings PR 1：补全 T1–T7 拆前集成测试与 `settings-harness.test-support.ts`）。
- **PR `#87`**（`5dc1caf`，2026-11-15）：`feat/settings-split-shell`（settings PR 2：抽出 3 个 `shared/*` 模块、归位 3 个面板胶水，使 `settings.ts` 从 1629 行降至 1332 行）。

## 遗留事项

1. **PR 3 与 PR 4 尚未施工**：`settings.ts` 仍有 1332 行，`general`、`preferences`、`appearance` 与 `api/*` 面板尚待按设计 §6 实施拆出。
2. **三项拆前发现的小缺陷已延后**（[settings-post-split-bugs.md](../internal-issue/2026-11-16-settings-post-split-bugs.md)）：`NAV_LABELS` 语言切换不刷新、`MIMO_ICON_URL` 未使用常量、`settings.fetchModels` 裸全局访问，均须待 PR 4 完成后单开 PR 修复。
3. **Electron 真机交互验证待执行**：设计 §8.2 的设置页窗口壳层、导航键盘快捷键、外观持久化与 API 弹窗真机联调尚未执行。
