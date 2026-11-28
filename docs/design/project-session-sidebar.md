状态：设计提案（现状整理）
实现状态：已实现

# Firefly 项目与会话侧栏

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
按模式保存项目、分组与排序，让会话组织不改变工作区授权。

## 当前实现
| 能力 | 文件与关键类型 |
|---|---|
| 契约 | `src/shared/sidebar-layout.ts` 的 `SidebarLayout`、`SidebarMutation` 包含修订、共享项目登记与三模式布局。 |
| 持久化 | `src/main/features/sessions/sidebar-layout-store.ts` 的 `createSidebarLayoutStore` 从 StorageContext 定位 sidebar-layout.json，校验、对账并原子替换。 |
| IPC | `src/main/features/sessions/sidebar-layout-ipc.ts` 验证聊天主窗口及 mainFrame，读取和提交布局。 |
| 状态 | `src/renderer/react/features/chat/pages/use-sidebar-layout.ts` 串行提交，冲突刷新并忽略卸载后迟到结果。 |
| 视图 | `src/renderer/react/features/chat/pages/sidebar-projection.ts`、`src/renderer/react/features/chat/pages/sidebar-tiers.ts` 生成显示层级；`src/renderer/react/features/chat/components/ConversationSidebar.tsx` 提供项目和会话菜单。 |

## 行为与失败边界
Chat 分组组织会话；Work / Code 按项目显示时分组组织整个项目，会话留在绑定工作区。布局按模式独立，项目身份从规范化根生成，显示名不是授权身份。会话及工作区绑定仍由 `src/main/features/sessions/chats-store.ts` 管理。

提交携带 expectedRevision；旧修订返回 conflict 及最新快照，无效补丁返回 invalid，读写失败返回 storage_error。合法保存使用本次拥有的临时文件、fsync 和 rename；失败不应覆盖旧布局。损坏 JSON 不自动重建覆盖；读取对账不等于已写回。单进程修订机制不是任意外部并发的数据库事务。

## 未完成与维护
当前按项目视图不保证空项目常驻；搜索、滚动、宽度及全部瞬时状态也没有由布局文件自动获得跨重启保证。跨模式共享布局、自由移动项目内会话和空项目常驻均未决定。性能测量采用[提醒与界面计划](../superpowers/plans/reminders-and-ui.md)，不预设虚拟化门槛。

已有测试：`src/shared/sidebar-layout.test.ts`、`src/main/features/sessions/sidebar-layout-store.test.ts`、`src/main/features/sessions/sidebar-layout-ipc.test.ts`、`src/renderer/react/features/chat/pages/sidebar-tiers.test.ts`。本次未执行；长列表、键盘和窄窗未验收。
