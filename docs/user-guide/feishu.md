# 飞书接入

状态为用户文档。代码与中文界面核对日期 2026-11-14，维护者 hotaru。

## 准备条件

准备有管理权限的飞书企业自建应用、App ID / App Secret、可访问飞书服务的网络，以及 Firefly 中可用的模型配置。当前适配器仅处理 p2p 私聊，群聊消息会被忽略。

## 平台配置

1. 在飞书开放平台创建企业自建应用，添加机器人能力，保管应用凭据。
2. 在事件与回调中选择“使用长连接接收事件”，订阅接收消息事件 `im.message.receive_v1`。长连接无需公网回调地址或内网穿透。
3. 按私聊收发需要申请读取用户发给机器人的单聊消息权限 `im:message.p2p_msg:readonly` 和发送消息权限 `im:message:send_as_bot`。媒体还需按消息资源接口申请资源读取、上传权限，在控制台核对实际权限项。
4. 按企业审批要求创建并发布应用版本，使权限、事件订阅和可用范围生效。让测试用户位于应用可用范围。

2026-11-14 查阅官方资料，长连接订阅方式及两个权限标识可核对。官方页面为动态内容，全部媒体权限与发布流程仍需发版前用目标企业账号复核。

- [飞书长连接配置](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)
- [飞书机器人与外部用户的权限说明](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group?lang=zh-CN)

## Firefly 配置与准入验证

1. 打开设置 → “连接手机” → “飞书”，填入“App ID”“App Secret”，开启渠道，点击“保存并连接”。
2. 由测试用户私聊机器人。新配置默认 `allowAnyPrivate: false`、`allowedSenderIds: []`，首次陌生消息会被拦截。
3. 在发送者设置的“待批准”列表核实身份后点击“批准”，由对方重新发一条消息验证。批准后的后续消息可进入处理，旧消息不会自动重放。
4. 再用一个未批准身份发送消息，确认不会触发回复。测试时保持工具关闭。

连接状态表示 SDK 通道状态。连接成功后，消息仍须经过私聊筛选和发送者准入。批准只授予该身份消息准入，工具范围由公共工具设置决定。

## 消息与媒体能力

适配器支持发送文本、图片、音频、文件、视频、卡片及以图片发送的贴纸。图片需要本地 filePath，URL 图片应先下载。Opus 与其他音频的时长处理存在区别，发送能力取决于平台资源权限和本地文件。入站图片、文件、音频、视频和贴纸资源在准入后下载到本地缓存。媒体被接收也仍受模型能力和附件授权约束。不可用回执和 SDK 发送异常会返回失败。

## 排障

| 现象 | 核对方法 |
|---|---|
| 连接失败 | 核对 App ID / Secret、网络、应用状态和脱敏错误。 |
| 已连接但陌生用户无回复 | 看“待批准”及允许名单，批准后重新发消息。 |
| 已连接但所有消息无回复 | 检查 p2p 私聊、消息事件订阅、权限、发布版本和应用可用范围，再检查模型配置。 |
| 文本正常、媒体失败 | 核对资源权限、文件与格式、SDK 错误和消息回执。 |
| 能聊天但没有工具调用 | 核对公共工具开关和权限说明。 |


## 模式与权限

先在“连接手机”的公共设置关闭工具，再测试身份准入。当前私聊开启工具后采用 Work / allow_all，工具直接执行，可能读写文件、运行命令。渠道没有交互审批。QQ 与官方 QQ 群聊强制 Chat。桌面模式切换及“上下文绑定”均不会扩大渠道权限。计划中的只读收紧尚待实现。

## 数据位置

当前正式目录、1.2.0 待落实的目录、隔离测试和外部服务处理范围见用户指南首页。只用全新隔离目录测试，避免向公开反馈提供凭据、openid、聊天正文及附件。

- [数据与公共权限说明](./index.md)
- [完整免责声明](../disclaimer.zh-CN.md)

## 停用

关闭该渠道卡片标题旁的开关，点击卡片保存按钮，确认状态停止。重启后再次核对开关与状态。必要时在平台侧撤销应用凭据或停止客户端，防止继续投递。关闭公共工具开关可收回渠道工具执行能力。

## 实现依据

写作前已用 `git grep -n` 核对 `settings/i18n/zh-CN.json` 的 `heading`、`feishuAppId`、`feishuAppSecret`、`feishuSaveButton` 和 `contextHint`，以及以下入口。

- `src/main/features/channels/adapters/feishu/index.ts` 的 `FeishuAdapter`、`sendLark`、`normalizeLarkMessage`。
- `src/main/features/channels/settings-store.ts` 的 `defaults`，以及 `sender-gate.ts` 的 `admitSender`。
- `src/renderer/settings/channels/sender-panel.ts` 的批准处理与 `panel.ts` 的保存处理。

真实平台账号收发与停用恢复尚待验收。
