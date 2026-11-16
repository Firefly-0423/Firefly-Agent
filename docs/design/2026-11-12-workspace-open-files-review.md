状态：设计提案（现状整理）
实现状态：已实现

# Firefly 外部应用打开工作区

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
从会话打开其绑定项目，明确外部启动与内部文件预览、运行审查的边界。

## 当前实现
`src/renderer/react/features/chat/components/OpenWorkspaceMenu.tsx` 及 `src/renderer/react/features/chat/components/ConversationSidebar.tsx` 提供打开方式；`src/preload/index.ts` 暴露受控桥；`src/shared/ipc-channels.ts` 定义 WORKSPACE_OPEN_IN 与 WORKSPACE_OPEN_IN_LIST_APPS。

`src/main/features/sessions/open-in-app.ts` 的 `registerOpenInAppIpc` 只接受 sessionId 和 appId，Main 从绑定解析真实目录。`resolveOpenInApps` 探测本机程序，`launchDetachedApp` 使用已检测可执行文件和预设参数数组启动；资源管理器使用 shell.openPath。界面不能传任意启动命令，打开目标是工作区根，不是右侧选中的文件。

## 行为与失败边界
无绑定、目录丢失、应用未找到和启动失败分别返回 NO_WORKSPACE、WORKSPACE_MISSING、APP_NOT_FOUND、LAUNCH_FAILED。启动失败不更新成功首选项；指定应用失败后清理检测缓存。默认 1500ms 的启动观察结束不代表外部程序已完整载入项目。

首选程序保存在模块变量 lastOpened，只在当前进程共享，不是每会话或跨重启偏好。探测缓存也不保证新装程序立即出现。外部打开 handler 当前没有采用文件读取 IPC 同样的来源窗口守卫，不能写成授权检查完全相同；是否补强需核对所有合法窗口。

外部程序遵守自身权限；Firefly 工具审批不能约束用户在外部程序内的操作。内部当前文件与固定运行快照另见[文件与差异](2026-11-12-workspace-file-and-diff-panels.md)，不得据当前仓库状态重算旧运行成果。

## 未完成与维护
跨重启首选项、全局或会话范围、来源窗口守卫补强尚未决定。现有测试入口：`src/main/features/sessions/open-in-app.test.ts`。后续用替身核对可执行文件、完整参数、失败码和零额外启动；本次未启动任何外部应用，真实菜单、窗口可见和焦点未验收。
