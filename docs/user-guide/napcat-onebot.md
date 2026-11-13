# NapCat / OneBot 接入

状态为用户文档。代码与中文界面核对日期 2026-11-14，维护者 hotaru。

## 准备条件

自行准备并维护 NapCat 与 QQ 登录，确认版本支持所需 OneBot v11 能力，配置 Firefly 模型。QQ 客户端协议接入受平台规则、账号及客户端状态影响，请评估账号与内容风险。

## 平台配置

Firefly 在 Windows 监听反向 WebSocket，NapCat 使用 WebSocket Client 连接。在 NapCat 网络配置中添加客户端，启用后填入 Firefly 页面显示的完整“NapCat 连接 URL”。保留页面给出的端口和路径，不照抄其他机器的地址。配置 Token 时应由客户端发送 `Authorization: Bearer <Token>`，URL 查询参数中的 Token 无法通过当前服务端鉴权。

2026-11-14 尝试读取 NapCat 官方网络配置页失败，版本对应的客户端字段名仍待发版前复核。此处网络方向和鉴权描述来自 Firefly 实现。

- [NapCat 网络配置](https://napneko.github.io/config/network)

## Firefly 配置

1. 设置 → “连接手机” → “QQ（NapCat / OneBot 11）”，选择“监听模式”与“监听端口”。
2. 同机客户端可选“仅本机 127.0.0.1”。WSL 客户端选“Windows WSL 虚拟网卡”，需能检测到该接口；“自动（优先 WSL，失败回环）”在未发现 WSL 网卡时用回环，接口枚举失败会报告错误。
3. 使用“自定义地址”时填入本机可绑定且客户端可达的地址。非回环监听必须配置 Access Token。页面可能先生成并展示 Token，需复制到 NapCat 后再次保存。即使回环监听配置了 Token，客户端也必须正确提供。
4. 在“私聊 QQ 白名单”填写允许的 QQ 号，在“群号白名单”填写可信群号。开启渠道，点击“保存并启动监听”，复制实际 URL 给 NapCat，再点击“测试连接”。

网络端口只向必要的可信网络开放。WSL 和自定义非回环地址会使服务可被该网络访问，Token 应保密。

## 准入验证

- 私聊仅允许白名单内 QQ 号，使用允许和拒绝两个身份分别验证。
- 群聊仅允许白名单内群。当前设置加载将 `groupRequireMention` 固定为 `true`，群聊还必须 @ 当前机器人，界面没有关闭此要求的开关。
- 底层 `isQqEventAllowed` 存在 `groupRequireMention=false` 分支，但持久化配置会规范化为 true。修改配置文件无法持久开启免 @。
- 使用白名单外群、未 @ 的消息验证没有回复。再在白名单内群 @ 机器人验证处理。

## 消息与媒体能力

适配器支持文本、图片、贴纸、语音和文件。声明支持视频，具体片段发送与客户端版本需实测。卡片会转为文本。文本按 1500 个 Unicode 码点分段。媒体传输支持分块能力探测和降级，具体以状态、文件大小限制和客户端响应为准。群回复使用引用及 @。连接握手会核实登录账号，拒绝另一账号替换当前会话。

## 排障

| 现象 | 核对方法 |
|---|---|
| 监听未启动 | 检查端口占用、监听地址、WSL 检测和非回环 Token 要求。 |
| NapCat 无法连接 | 复制实际 URL，检查网络方向、路径、防火墙和客户端是否启用。 |
| HTTP 401 | 核对 Bearer Token，去掉 URL 查询式凭据。 |
| 已连接但消息无回复 | 核对白名单、群内 @、登录账号及模型，连接成功不会绕过准入。 |
| 媒体失败或降级 | 看客户端版本、流式能力及动作错误，先用短文本排除连接问题。 |


## 模式与权限

先在“连接手机”的公共设置关闭工具，再测试身份准入。当前私聊开启工具后采用 Work / allow_all，工具直接执行，可能读写文件、运行命令。渠道没有交互审批。QQ 与官方 QQ 群聊强制 Chat。桌面模式切换及“上下文绑定”均不会扩大渠道权限。计划中的只读收紧尚待实现。

## 数据位置

当前正式目录、1.2.0 待落实的目录、隔离测试和外部服务处理范围见用户指南首页。只用全新隔离目录测试，避免向公开反馈提供凭据、openid、聊天正文及附件。

- [数据与公共权限说明](./index.md)
- [完整免责声明](../disclaimer.zh-CN.md)

## 停用

关闭该渠道卡片标题旁的开关，点击卡片保存按钮，确认状态停止。重启后再次核对开关与状态。必要时在平台侧撤销应用凭据或停止客户端，防止继续投递。关闭公共工具开关可收回渠道工具执行能力。

## 实现依据

写作前用 `git grep -n` 核对 `settings/i18n/zh-CN.json` 的 `qqTitle`、`qqSaveButton`、`qqListen*`、`qqUrl`、`qqPrivateAllowlist`、`qqGroupAllowlist` 与 `toolPermissionAllDesc`。

- `src/main/features/channels/adapters/qq/napcat-adapter.ts` 的 `isQqEventAllowed`、`NapCatAdapter` 和 `splitQqText`。
- 同目录 `onebot-reverse-ws.ts` 的 `resolveOneBotListenHost`、`resolveQqListenAuthRequirement`、`tokenMatches` 与 `OneBotReverseWsServer`。
- `src/main/features/channels/settings-store.ts` 的 `normalize`。
- `src/renderer/settings/channels/panel.ts` 的保存、连接 URL 和鉴权预检处理。

真实 NapCat / QQ 收发与停用恢复尚待验收。
