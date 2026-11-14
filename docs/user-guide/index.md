# 用户指南

状态为用户文档，核对日期 2026-11-14。维护者 hotaru。

首次使用请阅读完整免责声明。各模式与渠道的权限范围见其中第 ④ 条。桌面切换模式和上下文绑定均不会扩大渠道工具权限。

- [中文免责声明](../disclaimer.zh-CN.md)
- [English disclaimer](../disclaimer.en.md)

## 选择渠道

| 渠道 | 适用准备 | 指南 |
|---|---|---|
| 飞书 | 有自建应用管理权限，使用官方 SDK 长连接接收私聊 | [飞书](./feishu.md) |
| NapCat / OneBot | 自行维护 NapCat 和 QQ 登录，能配置反向 WebSocket 客户端 | [NapCat](./napcat-onebot.md) |
| 官方 QQ 机器人 | 有 QQ 开放平台机器人及测试资格，接受文本出站与被动回复限制 | [官方 QQ](./qqbot-official.md) |

## 公共模式与权限

渠道工具关闭时使用 Chat。QQ 与官方 QQ 群聊强制 Chat。当前私聊开启工具使用 Work 和 allow_all，工具直接执行，可读写文件、运行命令，请先收紧身份准入。渠道无法提供交互审批。未来只读收紧仍待渠道施工合并，详见免责声明模式表。

“上下文绑定”共享文字上下文，绑定目标的桌面模式不会提升远程权限。渠道记忆按账号、发送者、聊天类型、群和线程隔离，开放群聊前仍须评估输入和回复的隐私风险。

## 数据位置与排障资料

当前代码的正式目录为 `%APPDATA%\Firefly`。1.2.0 目标目录 `%APPDATA%\Firefly-1.2.0` 尚待启动隔离施工落实。不要复制或迁移旧版数据来验证 1.2.0。源码启动脚本默认使用仓库 `output/development-profile`，并固定 development profile。设置 `FIREFLY_ISOLATION_ROOT` 可改用全新已存在目录。直接启动 Electron 入口时可另设 `FIREFLY_RUNTIME_PROFILE=test` 选择 test profile，并同时设置独立根。正式目录与隔离目录必须互不重叠。

凭据、本地聊天、记忆和日志需要保护。外部平台和模型服务会处理相应消息及上下文。排障时先记录渠道、连接状态、时间、允许或拒绝的身份及脱敏错误，再按对应指南检查。公开反馈前移除密钥、Token、openid、聊天正文、真实路径和私人附件。
