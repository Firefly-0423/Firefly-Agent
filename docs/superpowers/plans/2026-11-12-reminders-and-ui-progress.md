# 提醒与界面体验施工进度

状态：未开工
施工计划：[2026-11-12-reminders-and-ui.md](./2026-11-12-reminders-and-ui.md)

本文是交接入口。每完成一个任务就更新下面各节；换会话或换人时先读这里，再读施工计划。

## 1. 当前状态

- 分支：`dev/firefly-1.2.0`（尚未建施工分支）
- 进行到：未开工
- 工作区：—

## 2. 已完成项

无。

## 3. 未完成项

| 施工包 | 任务 | 状态 |
|---|---|---|
| A 接入 1.2.0 新数据目录 | A1 切换正式配置至 `%APPDATA%\Firefly-1.2.0` 并验证与 1.1.x 目录完全隔离、A2 验证启动预检与 `StorageContext` 存储根归属新目录 | 未开始（若统一数据隔离已合入则跑回归验收） |
| B 提醒目标契约、可信事件归属与窗口激活分发 | B1 定义 `AttentionNavigationRequest` 与五类事件归属、B2 `toast-service` 目标构造与 `window-activation` 传递 | 未开始（依赖 A） |
| C 聊天窗口就绪缓冲与渲染端精确落点 | C1 `ReactChatSessionDispatcher` ready 缓冲与合并投递、C2 `attention-navigation` 状态机与交互/计划落点、C3 `ScheduledTaskPanel` 早于最近十条历史记录定位 | 未开始（依赖 B） |
| D 补队列入口与停止三模式回归 | D1 三模式忙时 Enter 入队、Shift+Enter 与停止按钮独立性、D2 跨会话队列隔离、落盘失败保留与重启认领顺序 | 未开始 |
| E 图片格式校验与用户可见失败反馈 | E1 `image-delivery` 契约与格式/转述失败收口、E2 `firefly.image.delivery.issue` 事件与聊天附件界面展示 | 未开始（依赖 A） |
| F 统一计划阶段只放行明确读取策略 | F1 `plan-tool-policy.ts` 纯策略与 `effectKind` 盘点、F2 接入 `tool-runtime` / `tool-dispatcher` 及等待期与伙伴边界 | 未开始 |
| G 手动压缩刷新回归与不支持压缩提示 | G1 手动压缩成功快照与页面即时刷新回归、G2 `MEMORY_CONTEXT_LEGACY_COMPACTION_UNSUPPORTED` 提示统一 | 未开始 |
| H 三模式流式消息性能基线与条件性局部修复 | H1 扩展 `react-perf` 三模式基线与流式消息缓存边界测试（按测量结果决定是否局部修改） | 未开始 |
| I 设置搜索标题栏弹窗与异步可靠定位 | I1 稳定目标索引 `data-settings-search-id` 与脱敏及条件过滤、I2 `search-target` 异步定位状态机与 `search-dialog` 弹窗交互 | 未开始 |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| 全量测试 `npm test` | — | — |
| 类型检查与构建 | — | — |
| 性能基线 `npm run perf:chat-baseline` | — | — |
| 真机验证 | — | — |

## 5. 偏离计划

无。
