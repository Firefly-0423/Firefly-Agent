# 官方 QQ 机器人接入

状态为用户文档。代码与中文界面核对日期 2026-11-14，维护者 hotaru。

## 准备条件与平台配置

在 QQ 开放平台创建机器人，准备 AppID / AppSecret，按后台要求配置测试环境、测试用户和群及能力权限，再按平台流程发布。请遵守平台账号、内容和安全规则。

2026-11-14 尝试访问官方消息概述页面失败。官方文档源码库的发送说明可访问，但含不同场景规则，不能直接视为当前 QQ 单聊和群聊配额。沙箱权限名、发布流程及平台最新配额需在发版前用目标机器人后台复核。以下 60 分钟 / 4 次与 5 分钟 / 5 次均为 Firefly 本地限制。

- [QQ 开放平台](https://q.qq.com/)
- [官方消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [官方文档源码的发送说明](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)

## Firefly 配置

1. 设置 → “连接手机” → “QQ 机器人（官方开放平台）”，填写“AppID”“AppSecret”。
2. 根据机器人当前环境在开放平台配置沙箱测试用户，开启渠道，点击“保存并连接”，用“测试连接”核对凭据与网关访问。
3. 由测试身份发送消息，查看页面“最近一条被白名单拒绝的消息来自 openid”提示。核实身份后，将其填入“单聊用户 openid 白名单”；群消息应使用“群 openid 白名单”。
4. 再次点击“保存并连接”，让测试身份重发消息。若打开“放行所有单聊”，任何能够向机器人发送私聊的平台身份都可触发处理，请先保持工具关闭。

openid 由平台按应用与场景提供，与 QQ 号属于不同标识。请从本机器人实际拒绝提示获取。该提示可能显示用户或群 openid，按消息来源填写对应字段。

## 准入验证

分别验证允许单聊、未允许单聊、允许群及未允许群。单聊可配置放行全部，群聊必须列入群 openid 白名单。适配器接受 `GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE` 两类群事件，实际可收到的事件受平台权限影响。不能仅靠“群里没有 @”来判断消息一定不会进入处理。群聊强制 Chat，禁用工具。

## 消息与媒体能力

当前出站仅文本，卡片可降为文本；图片、音频、文件、视频和贴纸出站不受支持。入站附件可进入下载处理，但模型可见内容仍受模型与附件授权约束。

每条已准入入站消息建立回复上下文。私聊窗口为收到后 60 分钟、最多 4 次，群聊为 5 分钟、最多 5 次。恰好等于时间边界时本地仍允许，超出后拒绝，平台仍可自行拒绝。分段文本会消耗多次额度，发送尝试失败也可能消耗本地序号。后续新入站消息会刷新该聊天的回复上下文。当前适配器没有主动发送路径，定时或外部投递也必须满足已有回复上下文与额度。

## 排障

| 实际失败返回或现象 | 原因及处理 |
|---|---|
| 网关未连接 | 检查凭据、网络和渠道状态。 |
| 已连接但消息被拒 | 根据最近拒绝 openid 核对白名单、测试用户与场景。 |
| 没有可引用的入站消息 | 当前目标没有已准入回复上下文，先由允许身份重新发消息。 |
| 被动回复窗口已过 | 私聊或群聊窗口已过，请让对方重新发消息。 |
| 回复次数已达上限 | 当前入站消息额度已用完，缩短回复或等待对方新消息。 |
| 文本可发、图片不可发 | 当前出站能力仅文本。 |
| 平台接口拒绝 | 根据脱敏平台错误核对权限、内容、URL 配置与平台频率规则。 |


## 模式与权限

先在“连接手机”的公共设置关闭工具，再测试身份准入。当前私聊开启工具后采用 Work / allow_all，工具直接执行，可能读写文件、运行命令。渠道没有交互审批。QQ 与官方 QQ 群聊强制 Chat。桌面模式切换及“上下文绑定”均不会扩大渠道权限。计划中的只读收紧尚待实现。

## 数据位置

当前正式目录、1.2.0 待落实的目录、隔离测试和外部服务处理范围见用户指南首页。只用全新隔离目录测试，避免向公开反馈提供凭据、openid、聊天正文及附件。

- [数据与公共权限说明](./index.md)
- [完整免责声明](../disclaimer.zh-CN.md)

## 停用

关闭该渠道卡片标题旁的开关，点击卡片保存按钮，确认状态停止。重启后再次核对开关与状态。必要时在平台侧撤销应用凭据或停止客户端，防止继续投递。关闭公共工具开关可收回渠道工具执行能力。

## 实现依据

写作前用 `git grep -n` 核对 `settings/i18n/zh-CN.json` 的 `qqBotTitle`、`qqBotAppId`、`qqBotAppSecret`、`qqBotUserAllowlist`、`qqBotGroupAllowlist`、`qqBotAllowAny`、`qqBotSaveButton` 与 `contextHint`。

- `src/main/features/channels/adapters/qqbot/qqbot-adapter.ts` 的 `normalizeQqBotEvent`、`isQqBotEventAllowed`、`handleDispatch`、`send`、`partToChunks`、`REPLY_WINDOW_MS`、`REPLY_SEQ_LIMIT`。
- `src/main/features/channels/agent-policy.ts` 的 `resolveChannelAgentPolicy` 与 `enforceChannelAgentPolicy`。
- `src/renderer/settings/channels/panel.ts` 的 `renderQqBotDetail` 与保存处理。

真实开放平台机器人收发与停用恢复尚待验收。
