# 渠道与视觉配置施工进度

状态：未开工
施工计划：[2026-11-12-channels-and-vision.md](./2026-11-12-channels-and-vision.md)

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
| A 建立 1.2.0 数据隔离前置条件 | A1 production 切换至 `%APPDATA%\Firefly-1.2.0`、A2 开发启动器默认隔离根、A3 越界/重叠/junction 拒绝、A4 重启只读自身新数据 | 未开始（若版本基础主题已交付则核对提交与验收记录） |
| B 统一图片入口的档案选择与请求快照 | B1 `resolveRunModelSelection` 与默认档案完整配置、B2 三级优先级表驱动、B3 `MODEL_PROFILE_NOT_FOUND`、B4 `MODEL_PROFILE_REQUIRED`、B5 请求级快照与直发失败转述、B6 `chat-ui-ipc` 双入口统一与 `reject`、B7 记忆入口拒绝保留 | 未开始（依赖 A） |
| C 落实图片组合矩阵及三协议一致转述 | C1 18+3 矩阵与矩阵文档、C2 `IMAGE_MODEL_UNSUPPORTED`、C3 `IMAGE_TRANSPORT_UNSUPPORTED`、C4 未确认组合试发/`IMAGE_TRANSPORT_UNVERIFIED`、C5 三协议请求块契约、C6 畸形输入拒绝、C7 `vision-captioner` 三协议、C8 转述失败码、C9 拒绝后不重发、C10 工具安全边界、C11 转述脱敏 | 未开始（依赖 B） |
| D 渠道完整链路及可排查失败结果 | D1 成功链路与 `channel-diagnostics`、D2 `profile` 阶段、D3 `agent` 终态、D4 `delivery` 阶段、D5 异常脱敏、D6 群聊强制 Chat、D7 日志写盘失败、D8 设置页诊断展示 | 未开始（依赖 B、C） |
| E 主动聊天阶段诊断和内部受控入口 | E1 契约与 `preview` 零副作用、E2 无候选、E3 策略拦截原因、E4 `silent`、E5 模型失败、E6 epoch/取消保护、E7 并发保护、E8 诊断 IPC 门禁、E9 临界点回归、E10 摘要落盘与 100 条上限 | 未开始（依赖 A、B） |
| F 主动消息提醒与三窗口状态可见性 | F1 落库后发布事件、F2 失败/取消不提醒、F3 `messageId` 去重、F4 关闭窗口点击打开、F5 其他会话不切换、F6 聚焦刷新与抑制、F7 提醒失败隔离、F8 清理计时器与订阅 | 未开始（依赖 E） |
| G 三份渠道接入指南、契约核对与发布验收记录 | G1 飞书准入、G2 NapCat @ 条件与白名单、G3 NapCat Token、G4 QQ Bot openid 与被动回复限制、G5 媒体常量边界、G6 三份指南与矩阵真机记录 | 未开始（依赖 C、D） |

## 4. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|
| 全量测试 `npm test` | — | — |
| 启动器脚本测试 `node --test scripts/dev/launch-electron.test.mjs` | — | — |
| 类型检查与构建 | — | — |
| 真机与打包验证 | — | — |

## 5. 偏离计划

无。
