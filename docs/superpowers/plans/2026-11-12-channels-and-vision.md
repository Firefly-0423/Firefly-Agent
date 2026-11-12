# Firefly-Agent 1.2.0 施工计划：渠道与视觉配置

## 1. 目标

让用户在 Chat、Work、Code 中获得一致、可解释的图片处理行为：使用正确的模型档案，根据供应商、模型输入能力和实际传输协议决定能否发送图片；不能处理时明确说明原因，避免界面判断、后台调用和工具读取各用一套配置。

让外部渠道和主动聊天具备可验收的完整链路：渠道消息能够使用默认档案生成并回复，失败结果可以定位到具体阶段；主动聊天能够区分未产生候选、策略拦截、模型沉默、生成失败、投递失败、落库成功和提醒失败。提供 Firefly 专用的飞书、NapCat、官方 QQ 机器人指南。

本计划以 `c991111efa68087b9d625868179c03fea1b83e14` 为基线。实际工作区为 detached HEAD，`dev/firefly-1.2.0` 包含该提交，工作树干净。本次仅进行了只读核对，没有创建文件、修改代码、运行测试或构建；以下验证均为施工阶段要求。

约束：

- 1.2.0 使用新的数据目录，不读取、不迁移 1.1.x 用户数据。
- 仅沿用 Firefly 当前模块和接口，不复制外部参考文档中的实现。
- 不新增依赖、检查工具或 CI 阈值，不将历史验证记录当作当前通过证明。
- 新增及改变行为先写失败测试；已经存在且符合要求的能力仅补覆盖，不重新实现。
- 本计划中的新增文件、类型、错误码和 IPC 均为拟新增设计，区别于现有接口。

## 2. 现状

### 2.1 模块边界

按 `README.md:261` 起的目录职责表：

| 模块 | 当前职责及证据 |
|---|---|
| `application/`、`startup/` | 启动装配、IPC、运行档案和数据隔离，`README.md:262`、`:263` |
| `orchestrator/` | Agent、模型适配及执行链路，`README.md:264` |
| `chat/`、`chats/` | 聊天入口、会话和派发，`README.md:266` |
| `channels/` | 飞书、微信、QQ、QQ Bot，`README.md:271` |
| `proactive/` | 主动聊天策略和投递，`README.md:272` |
| `preload/`、`renderer/`、`shared/` | IPC 桥接、界面、共享契约，`README.md:278`—`:280` |

已有相关主动聊天方案及验证记录属于历史记录；本次沿用当前源码中的策略，不重新开启历史调参或整仓改造。

### 2.2 图片转换和能力解析已有实现

1. **Anthropic 图片转换已完成，移出新增功能范围。**  
   `src/main/orchestrator/vendors/anthropic-adapter.ts:35` 的 `toAnthropicContent` 已将图片转换为 `source.type="base64"` 或 `"url"`，对不支持的嵌入式 MIME 降级为文本；用户消息在该文件 `:97` 调用转换。现有测试覆盖 PNG、远程 URL、JPEG、WEBP、GIF 和不支持的 MIME，见 `anthropic-adapter.test.ts:139`—`:147`。

2. **模型输入能力已有统一入口。**  
   `src/main/orchestrator/vendors/multimodal.ts::resolveInputModalities` 根据档案声明、内置目录、未知保守回退判断图片能力；`src/main/settings/model-settings.ts:283` 的 `resolveModelSettingsProfile` 将结果展开为 `multimodal`。目录位于 `vendors/model-modalities.catalog.ts:22`。

3. **当前直发路由只检查 `multimodal`。**  
   `src/main/orchestrator/image-router.ts:36`—`:43` 没有检查供应商端点与传输组合。`vendors/capabilities.ts::PROVIDER_CAPABILITIES` 已列出供应商支持的协议，但该字段不能单独证明图片能力。缺口是组合覆盖及端点能力判定，不能据此宣称所有组合可用。

4. **传输选择已有统一函数。**  
   `vendors/transport-detector.ts::resolveTransport` 优先使用 `explicitTransport`，否则使用供应商默认协议；`vendors/index.ts::getAdapterForConfig` 按实际协议创建适配器。Responses 图片转换已在 `responses-adapter.ts:33` 的 `toUserContentBlocks` 中实现。

### 2.3 默认档案解析已完成，入口之间仍有不一致

1. **不传档案 ID 时解析默认档案已经完成。**  
   `model-settings.ts:283`—`:307` 已实现默认档案展开，没有默认 ID 时由 `model-catalog.ts::resolveDefaultModelProfile` 选择首个档案。`model-settings.test.ts:57` 起已有显式、默认、回退和不存在 ID 的测试，不再安排重做。

2. **渠道主链路已经调用默认解析。**  
   `channels/bootstrap.ts:104` 使用 `resolveModelSettingsProfile(saved)` 判断图片能力；Agent 构建通过 `orchestrator/agent-runtime.ts:165` 展开档案。启用记忆入口时还会传入默认档案 ID，并保留 `MEMORY_RUN_PROFILE_DENIED` 等拒绝条件，见 `bootstrap.ts::run`。

3. **图片发送策略存在静态不一致。**  
   `chats/chat-ui-ipc.ts:184` 起的 `CHAT_GET_IMAGE_SEND_STRATEGY` 先读取原始设置，仅在会话绑定档案时展开；未绑定时没有按注释所述展开默认档案。相邻 `CHAT_CAPTION_IMAGE` 在 `:173` 则明确使用默认档案。两者可能对同一图片给出不同判断。

4. **直发失败转述也可能换用另一份档案。**  
   `orchestrator/agent-runtime.ts:193` 起的 `captionImageForFallback` 重新读取默认档案，没有使用产生本次请求的档案快照。

5. **转述配置与实际传输不一致。**  
   `image-router.ts:64` 仅排除显式 Anthropic，允许 Responses；但 `vision-captioner.ts::buildChatCompletionsUrl` 固定拼接 `/chat/completions`，`VisionConfig` 也不包含供应商和协议。未显式填写协议的 Anthropic 默认档案同样不能靠该判断可靠识别。

这些是静态源码证据，尚未通过真实服务复现。

### 2.4 渠道失败日志和终态回复已有实现

- `channels/dispatcher.ts::processIncoming` 已记录 `incoming`、Agent 异常和发送失败；`terminalReply` 已区分成功、超时、取消、运行失败以及部分输出。
- `channels/message-log.ts::LogEntry` 已有 `dir: "incoming" | "outgoing" | "error"`，日志位于当前 `userData/channels/log.jsonl`。
- 现有 `channels:log:get`、`channels:log:clear` 可用于查看和清理日志，见 `shared/ipc-channels.ts:38`、`:39`。

因此，不新增第二套渠道日志或重复实现失败回复；补充档案到发送回执的集成测试、阶段关联信息和错误脱敏。当前异常分支直接记录 `Error.message`，证据见 `dispatcher.ts::processIncoming`，不能假定异常内容天然适合写盘或展示。

### 2.5 主动聊天已有策略、阶段事件和取消保护

- 启动接线已存在，见 `application/background.ts:206`。
- 服务已有 `candidate_blocked`、`model_silent`、`commit_blocked`、`commit_cancelled`、`message_committed` 等事件，见 `proactive-service.ts::createProactiveChatService`。
- 触发器已有内部 `evaluateNow`，见 `proactive-trigger.ts:53`、`:395`，但返回 `Promise<void>`，尚不能作为阶段化诊断结果。
- 本地时间已按用户时区生成，见 `proactive-lifecycle.ts:115`、`proactive-trigger.ts:302`；不将外部参考文档中的时区疑点直接认定为当前缺陷。
- 当前策略包含两小时全局间隔、十二小时后续间隔、75 分门槛和两次未回复上限，见 `proactive-policy.ts:9`、`:10`、`:12`、`:48`。
- 本地投递已写入专用会话并广播变化，见 `proactive-lifecycle.ts:183`—`:199`；当前没有在该路径发布主动消息提醒事件。
- 阶段事件仍通过 `console.log` 输出，见 `proactive-lifecycle.ts:335`、`proactive-trigger.ts:280`。文件日志使用独立的 logger sink，默认级别为 `warn`，见 `logging/logger.ts::resolveDefaultLevel`、`initializeMainFileLogging`。不能保证这些阶段事件在打包版落盘。

### 2.6 提醒设施已有，无须另建通知系统

`toast/toast-service.ts::createToastService` 已支持通知档、去重、音效合并、点击激活和自动消失；共享 `ToastTarget` 已支持指定会话，见 `shared/toast-types.ts`。当前 `ToastKind` 没有主动消息类型。

聊天页收到会话变化后主要刷新当前模式列表，见 `ChatPage.tsx:337` 起的 `store.onChanged(refresh)`。仅有落库和列表广播，尚不足以证明关闭窗口、查看其他会话、正在查看主动会话三种状态下均能看到消息。

### 2.7 三个渠道实现已有，缺少产品指南

`git ls-tree -r --name-only HEAD docs/user-guide` 无输出。

| 渠道 | 已有实现和必须反映的差异 |
|---|---|
| 飞书 | `adapters/feishu/index.ts::rebuildChannel` 已使用 WebSocket，仅处理 `p2p`，且在下载媒体前调用 `admitSender`。`settings-store.ts:37` 默认关闭任意私聊放行，不能写成“没有白名单”。 |
| NapCat | `napcat-adapter.ts:31` 的 `isQqEventAllowed` 检查私聊、群白名单；群是否要求 @ 取决于 `groupRequireMention`。监听路径见 `onebot-reverse-ws.ts:10`，非回环无 Token 会拒绝，见 `:105`。 |
| 官方 QQ 机器人 | `qqbot-adapter.ts:15` 按 openid 放行；被动回复窗口和次数由 `REPLY_WINDOW_MS`、`REPLY_SEQ_LIMIT` 限制；出站能力当前仅文本。入站下载有 8 MiB 限制，见 `:223`。平台规则需要发布前重新核对。 |

外部渠道目前按 `channels/agent-policy.ts:12` 选择 Chat 或 Work；QQ、QQ Bot 群聊强制 Chat 且不暴露工具，没有独立 Code 渠道执行入口。

### 2.8 新数据目录尚未满足

`startup/runtime-profile.ts:55` 的 production 路径仍为 `%APPDATA%\Firefly`，与 `README.md:121`、`DEVELOPMENT.md:27` 一致。源码开发启动器也有既有默认隔离根，见 `scripts/dev/launch-electron.mjs::DEFAULT_ISOLATION`。

因此，新目录必须作为本主题运行验收的前置条件；不能直接启动当前 production 档案进行测试。

## 3. 设计

### 3.1 总体方案和模式表现

采用“统一档案选择、统一图片路由、沿用现有渠道与主动服务、补诊断和提醒”的增量方案。

| 场景 | Chat | Work | Code |
|---|---|---|---|
| 用户附件、粘贴和截图 | 按当前会话档案处理；未绑定时用默认档案 | 同左，保持任务附件授权 | 同左，保持工作区和附件授权 |
| 直发失败后的图片处理 | 使用本次请求快照，不另换模型 | 同左 | 同左 |
| `read_image`、`read_image_url` | 不因本计划新增工具权限 | 按现有工具可用性处理，默认档案提供视觉配置 | 同左，并保持工作区与网络边界 |
| 外部渠道 | 默认关闭工具时使用 Chat | 仅按现有渠道工具设置进入 Work | 不新增外部 Code 入口；桌面 Code 不影响渠道选择 |
| 主动聊天 | 写入专用 Chat 会话 | 空闲时可产生 Chat 提醒；不插入 Work 会话 | 空闲时可产生 Chat 提醒；不插入 Code 会话 |
| 正在运行或审批 | 保留已有 busy、取消保护 | 同左 | 同左 |

### 3.2 档案选择与配置快照

拟在 `settings/model-settings.ts` 增加统一选择函数：

`resolveRunModelSelection(settings, { boundProfileId?, pendingProfileId? })`

结果为成功的 `{ profileId, settings }`，或稳定错误码。

选择规则：

1. 桌面图片：会话绑定档案 → 欢迎页暂选档案 → 默认档案。
2. 渠道、主动聊天以及现有默认档案视觉工具：默认档案。
3. 明确提供但已删除的档案返回 `MODEL_PROFILE_NOT_FOUND`，不默默使用另一家供应商。
4. 完全没有档案时返回 `MODEL_PROFILE_REQUIRED`，提示创建模型档案。
5. 不改变现有 `resolveModelSettingsProfile` 的通用回退语义；新入口显式采用严格选择。

一次请求只捕获一份选择结果。图片能力判断、附件处理、Agent 请求和直发失败后的处理使用该快照。请求期间修改默认档案仅影响下一次请求。

### 3.3 图片路由、协议矩阵和转述

保留 `ImageSource`、`resolveImageRoute`、`resolveCaptionVisionConfig` 作为统一入口，扩充其输入和结果：

- 输入包含 `provider`、`model`、实际 `Transport`、解析后的输入模态及声明来源。
- 拒绝结果增加稳定 `code`，保留现有 `reason`。
- `CaptionVisionConfig` 携带供应商和实际协议，不能只返回地址、密钥、模型。

将三个维度分开：

1. **模型能力**：继续使用 `resolveInputModalities`，保留用户声明优先级。
2. **端点能力**：记录供应商、型号范围、协议的已确认支持、已确认不支持、未确认状态。
3. **序列化**：复用当前 OpenAI、Anthropic、Responses 适配器，不能由协议名称推导模型能力。

拟新增 `vendors/image-transport-policy.ts`，保存有官方资料依据的端点限制及判定函数；不复制一份模型模态目录。

推荐判定规则：

| 条件 | 结果 |
|---|---|
| 模型声明或解析结果为纯文本 | `IMAGE_MODEL_UNSUPPORTED` |
| 当前端点组合已确认不支持图片 | `IMAGE_TRANSPORT_UNSUPPORTED` |
| 模型支持图片且组合已确认支持 | 直发 |
| 组合未确认，用户明确声明图片输入 | 允许试发，失败如实返回 |
| 组合未确认，仅由目录推断图片能力 | `IMAGE_TRANSPORT_UNVERIFIED`，引导用户确认输入类型 |
| 自定义端点 | 使用显式协议和用户声明，不根据 URL 猜测供应商 |

未确认组合的默认行为需负责人拍板，见第 8 节。

矩阵覆盖当前 `PROVIDER_CAPABILITIES` 的全部十八个声明组合，以及自定义端点的三个协议：

- `minimax`：Anthropic、OpenAI、Responses。
- `deepseek`：OpenAI、Anthropic、Responses。
- `glm`：OpenAI、Anthropic。
- `kimi`：OpenAI。
- `qwen`：OpenAI、Responses。
- `chatgpt`：OpenAI、Responses。
- `claude`：Anthropic。
- `mimo`：OpenAI、Anthropic、Responses。
- `openrouter`：OpenAI。

每行记录模型样例或匹配范围、能力来源、协议、预期 wire 结构、官方依据及真实服务验证状态。不能把“适配器能生成请求”标成“服务已验证可用”。

本次核对的官方资料支持 Anthropic 图片源格式、OpenAI 图片输入格式，以及 MiniMax 当前 Anthropic 接口的图片支持；不能沿用旧文档中整个供应商一律禁图的判断。[Anthropic 视觉文档](https://platform.claude.com/docs/en/build-with-claude/vision)、[OpenAI 图片输入文档](https://developers.openai.com/api/docs/guides/images-vision)、[MiniMax Anthropic 接口文档](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)。

**转述建议统一支持三个现有协议。** `vision-captioner.ts` 改为使用 `getAdapterForConfig`、`buildRequest`、`parseResponse`，沿用现有非流式调用方式、视觉超时策略和输出预算，不新增独立视觉模型。

保留 `captionImage` 的字符串接口供现有工具使用；内部增加结构化结果，供 `captionImageSafe` 返回错误码。明确不支持图片或服务已明确拒绝图片时，不向同一端点重复发送同一图片，不进行递归转述重试。

### 3.4 图片 IPC 与中文界面

沿用：

- `chat:get-image-send-strategy`
- `chat:caption-image`
- `chat:get-image-preview`

前两个请求统一支持 `{ sessionId?, modelProfileId? }`。`captionImage` 继续携带文件路径和标注状态。

发送策略增加明确的 `reject` 分支；渲染端收到拒绝后停止图片转述及发送，不再将拒绝伪装成可用的 caption 路径。

新增文案进入对应中文 i18n 文件：

- “请先在「设置 → API 设置」创建并选择默认模型档案。”
- “当前模型不支持图片输入。”
- “当前模型与协议组合尚未确认支持图片，请核对该档案的输入类型。”
- “图片处理失败，诊断编号：{attemptId}。”

设置页使用 `renderer/settings/i18n/zh-CN.json`；聊天页使用 `renderer/react/i18n/zh-CN.json`。错误码保持稳定，用户文案不依赖字符串匹配。

### 3.5 渠道诊断

沿用 `LogEntry` 和现有日志 IPC，拟增加可选 `diagnostic`：

- `attemptId`
- `stage`：`profile`、`attachments`、`agent`、`delivery`
- `code`
- `profileId`
- `transport`
- `httpStatus`，仅在存在时记录

一个入站请求使用同一 `attemptId`。配置、运行和投递失败分别定位，不将“开始调用模型”记作成功回复。

原有消息正文日志保持现有用途；新增诊断字段仅允许固定字段，不写密钥、鉴权头、图片 base64、完整请求体、原始服务响应或带查询参数的 URL。Agent 异常分支改为先归一化、脱敏，再写日志和控制台。

保留现有超时、取消、运行失败提示；发送失败不追加成功 assistant 历史，也不广播成功出站镜像。

### 3.6 主动聊天诊断

拟新增 `shared/proactive-diagnostics.ts`，定义：

- `ProactiveDiagnosticResult`
- `ProactiveDiagnosticStage`
- 诊断控制错误码及结果状态

结果包含 `attemptId`、开始结束时间、场景、阶段有序列表、最终状态，以及成功落库后的 `sessionId`、`messageId`。不包含提示词、记忆正文和模型原始回复。

阶段：

`candidate → policy → model → delivery → persistence → notification`

每阶段明确 `passed`、`blocked`、`silent`、`failed`、`cancelled` 或 `not_run`。例如远端渠道投递不执行本地落库，应写明 `not_run`，不能假装所有阶段均成功。

新增内部 IPC，暂定：

- `proactive:diagnose`
- `proactive:diagnostics:get`

要求：

- 默认仅 development、test、smoke 档案可调用；production 返回 `PROACTIVE_DIAGNOSTICS_DISABLED`。
- 校验实际发送窗口、请求结构和运行档案；不只隐藏按钮。
- `preview` 只采集和计算，不调用模型、不投递、不改变状态或触发器边沿。
- `run` 复用真实 `evaluateNow` 和服务链路，不绕过开关、busy、冷却、未回复上限、epoch 或投递检查；可能产生真实模型调用和消息。
- 测试入口与定时扫描共享并发保护，禁止通过测试入口并行重复生成。
- 内部设置页显示“检查主动聊天”“执行一次真实检查”，后者说明会使用模型且可能发送消息。
- 没有候选、被策略拦截、模型沉默均为可解释结果，不统一显示为错误。

阶段记录接入现有文件 sink，保留最近 100 次诊断摘要。此上限为拟定值。成功摘要也必须在默认日志级别下落盘，不通过提高全局日志级别实现。诊断写盘失败不改变消息提交结果，界面明确提示“诊断记录未写入”。

策略、冷却、评分、天气场景和返回事件检测均保持当前行为。

### 3.7 主动消息提醒

扩展现有 Toast：

- 新增 `ToastKind: "proactive-message"`。
- 新增 `ProactiveMessageCommittedEvent`，只携带 `sessionId`、`messageId`、时间。
- 仅在本地消息成功落库后发布。
- `messageId` 作为去重业务 ID，目标为已有 `ToastTarget` 的指定会话。
- 默认文案“流萤发来了一条主动消息”，不展示私密正文；音效沿用现有开关。
- 点击后通过现有窗口激活代理打开专用 Chat 会话。

三种状态：

| 状态 | 表现 |
|---|---|
| 聊天窗口关闭或隐藏 | 显示 Toast；用户点击后打开主动会话 |
| 正在查看其他会话，包括 Work、Code | 显示 Toast，不自动切换当前会话 |
| 正在查看主动会话且窗口聚焦 | 刷新消息列表并显示新消息，抑制重复 Toast |

提醒失败单独记录，不能撤销已成功保存的消息，也不能触发重新生成或重新发送。

### 3.8 三份接入指南

新增：

- `docs/user-guide/feishu.md`
- `docs/user-guide/napcat-onebot.md`
- `docs/user-guide/qqbot-official.md`

统一包括前提、配置入口、权限、连接检查、首条文字消息、媒体测试、访问控制、模式限制、日志排障、停用和清理方法。

必须体现 Firefly 当前差异：

- 飞书包含发送者白名单、陌生发送者批准流程，群消息当前忽略。
- NapCat 明确连接方向、运行时 URL、默认端口、Token、白名单及可配置的 @ 条件；媒体参数取自 `onebot-media.ts` 常量。
- 官方 QQ 机器人区分 openid 与 QQ 号，说明仅被动回复、出站仅文本、长回复可能受到条数限制。
- 不写“零封号风险”“所有网络均可连接”等无法保证的结论。
- 平台权限、下载包名称和平台配额附官方链接与核对日期；未核实内容不能写成固定事实。
- 所有指南从全新 1.2.0 配置开始，不指导复制旧目录。

## 4. 改动清单

每步按“新增失败测试 → 最小实现 → 最近测试 → 类型检查”推进，独立形成可审查变更。后续步骤不以临时关闭测试或放宽检查为合入条件。

### 步骤 0：建立 1.2.0 数据隔离前置条件

若版本基础主题已完成此项，本主题只核对提交及验收记录，不重复修改。

| 文件 | 改动 |
|---|---|
| `src/main/startup/runtime-profile.ts` | production 解析到新的版本数据根；保持路径预检和隔离保护 |
| `src/main/startup/runtime-profile.test.ts` | 验证新旧路径隔离及路径逃逸拒绝 |
| `scripts/dev/launch-electron.mjs` | 默认开发隔离根与旧开发数据分离 |
| `scripts/dev/launch-electron.test.mjs` | 验证启动器默认路径及显式隔离根 |
| `src/main/startup/runtime-profile-documentation.test.ts` | 同步新路径契约 |
| `README.md`、`DEVELOPMENT.md` | 更新数据位置、全新配置和开发启动说明 |

新目录推荐 `%APPDATA%\Firefly-1.2.0`；最终名称由负责人决定。发布版本号由版本基础主题统一处理。

### 步骤 1：统一图片入口的档案选择

| 文件 | 改动 |
|---|---|
| `src/main/settings/model-settings.ts` | 增加严格的 `resolveRunModelSelection` |
| `src/main/chats/chat-ui-ipc.ts` | 两个图片入口使用相同档案优先级 |
| `src/preload/index.ts` | 扩展图片请求上下文，保持受控参数 |
| `src/renderer/react/features/chat/hooks/useComposerAttachments.ts` | 传递会话及暂选档案，处理 `reject` |
| `src/main/orchestrator/build-options.ts` | `captionImageForFallback` 接收本次 `ModelSettingsLite` 快照 |
| `src/main/orchestrator/agent-runtime.ts` | 使用传入快照，不重新读取默认档案 |
| `src/main/channels/bootstrap.ts` | 统一默认选择结果；保留记忆入口和附件授权 |
| 两套 `i18n/zh-CN.json` | 增加档案缺失、失效和图片拒绝文案 |

### 步骤 2：落实图片组合矩阵及协议一致的转述

| 文件 | 改动 |
|---|---|
| `src/main/orchestrator/vendors/image-transport-policy.ts`，新增 | 端点组合判定及来源记录 |
| `src/main/orchestrator/image-router.ts` | 组合判定、稳定拒绝码、完整转述配置 |
| `src/main/orchestrator/vision-captioner.ts` | 通过现有适配器构建和解析请求；保留超时和取消 |
| `src/main/chat/image-caption.ts` | 映射结构化失败，保留文件校验 |
| `src/main/orchestrator/tools/fs-tools.ts` | 适配完整默认档案视觉配置 |
| `src/main/orchestrator/tools/builtin-tools/read-image-url-tool.ts` | 同上，保留 URL 安全检查 |
| `src/main/orchestrator/build-options.ts` | 拒绝时停止图片发送，避免相同失败请求反复转述 |
| `docs/qa/1.2.0-image-channel-matrix.md`，新增 | 组合矩阵、官方依据和真实服务证据状态 |

已有适配器转换原则上只补测试；只有测试证明存在缺陷时才修改对应适配器。

### 步骤 3：渠道完整链路及可排查失败结果

| 文件 | 改动 |
|---|---|
| `src/main/channels/message-log.ts` | 增加可选结构化诊断，兼容当前日志行 |
| `src/main/channels/dispatcher.ts` | 关联请求阶段、稳定错误码和脱敏；保留终态回复 |
| `src/main/channels/bootstrap.ts` | 将安全的档案与协议元数据传到诊断边界 |
| `src/renderer/settings/channels/panel.ts`、`view-model.ts` | 展示诊断编号、阶段和中文原因 |
| `src/renderer/settings/shared/types.ts` | 同步诊断结果类型 |
| `src/shared/channel-diagnostics.ts`，新增 | 主进程与设置页共享的诊断契约 |
| `src/renderer/settings/i18n/zh-CN.json` | 阶段、失败原因文案 |

### 步骤 4：主动聊天阶段诊断和内部入口

| 文件 | 改动 |
|---|---|
| `src/shared/proactive-diagnostics.ts`，新增 | 请求、结果、阶段和错误码 |
| `src/main/proactive/proactive-diagnostics.ts`，新增 | 安全摘要、最近记录和文件 sink |
| `src/main/proactive/proactive-diagnostics-ipc.ts`，新增 | 内部入口及运行档案、发送方检查 |
| `src/main/proactive/proactive-trigger.ts` | 暴露无候选、快速拦截和退避结果，共享并发保护 |
| `src/main/proactive/proactive-service.ts` | 保留现有事件，补齐模型和投递结果 |
| `src/main/proactive/proactive-lifecycle.ts` | 串联阶段、默认档案和真实检查 |
| `src/main/application/default-dependencies.ts` | 装配诊断入口和关闭清理 |
| `src/shared/ipc-channels.ts`、`src/preload/index.ts` | 新增诊断通道及受控桥接 |
| `src/renderer/settings/shared/types.ts`、`settings.ts`、`index.html` | 内部构建检查入口和阶段结果 |
| `src/renderer/settings/i18n/zh-CN.json` | 结果、费用及真实投递说明 |

### 步骤 5：主动消息可见性

| 文件 | 改动 |
|---|---|
| `src/shared/toast-types.ts` | 增加主动消息种类和可选文案 key |
| `src/main/toast/toast-events.ts` | 增加提交事件 |
| `src/main/toast/toast-service.ts` | 去重、抑制、会话目标和自动消失 |
| `src/main/proactive/proactive-lifecycle.ts` | 成功落库后发布事件 |
| `src/main/application/default-dependencies.ts` | 复用活动会话和焦点判断 |
| `src/renderer/react/features/chat/pages/ChatPage.tsx` | 当前主动会话接收变化后刷新消息，不切换其他会话 |
| `src/renderer/toast/toast.ts` | 解析主动消息 i18n 文案 |
| `src/renderer/react/i18n/zh-CN.json` | 主动消息提醒文案 |

### 步骤 6：用户指南和发布验收记录

| 文件 | 改动 |
|---|---|
| 三份 `docs/user-guide/*.md` | Firefly 接入、限制、访问控制和排障指南 |
| `README.md` | 在渠道说明中链接指南 |
| `docs/qa/1.2.0-image-channel-matrix.md` | 补真实渠道、窗口状态和打包版验证证据 |

不为纯文档增加测试框架；使用既有渠道测试、实际操作及逐项核对验证。

## 5. 测试

所有测试遵循 `AGENTS.md`：稳定对象使用完整比较；失败同时断言没有越权调用、成功写入或泄露；时间边界使用假定时器并恢复；文件系统使用临时目录并清理。环境缺失必须显式跳过并记录原因。

### 步骤 0

测试文件：

- `src/main/startup/runtime-profile.test.ts`
- `src/main/startup/runtime-profile-documentation.test.ts`
- `scripts/dev/launch-electron.test.mjs`

用例：

- 新目录不存在、临时根中存在模拟旧目录 → 返回新根；启动后配置为空；旧目录没有读取、复制或写入。
- 同时启动不同运行档案 → `userData`、session、日志路径互不混用。
- 隔离根越界、与正式数据根重叠、junction 逃逸 → 断言现有稳定错误码；路径应用及设置加载均未执行。
- 重启同一 1.2.0 档案 → 读取自身新数据，不访问模拟旧目录。

### 步骤 1

测试文件：

- `src/main/settings/model-settings.test.ts`
- `src/main/settings/model-settings.vision.test.ts`
- `src/main/chats/chat-ui-ipc.test.ts`
- `src/main/orchestrator/agent-runtime.test.ts`
- `src/main/orchestrator/build-options.test.ts`
- `src/main/channels/bootstrap.test.ts`
- `src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`

用例：

- 顶层镜像为空、默认档案完整 → 发送策略、转述和渠道请求全部使用默认档案的完整配置；不使用镜像地址或凭据。
- 会话绑定 A、欢迎页暂选 B、默认 C → 按优先级分别选中；三个模式使用相同表驱动用例。
- 显式档案已删除 → 返回 `MODEL_PROFILE_NOT_FOUND`；模型、转述、附件读取及成功消息写入均未发生。
- 没有任何档案 → 返回 `MODEL_PROFILE_REQUIRED`；不发网络请求、不保存自动生成的档案。
- 请求开始后默认档案变化 → 当前请求及失败处理仍使用原快照；下一请求使用新默认。
- UI 收到 `reject` → 展示对应中文原因；不调用 caption，也不发送图片。
- 保留现有记忆入口拒绝测试 → 不因统一档案选择绕过 ingress 或附件 grant。

### 步骤 2

测试文件：

- 新增 `src/main/orchestrator/vendors/image-transport-policy.test.ts`
- `src/main/orchestrator/image-router.test.ts`
- 三个现有 `vendors/*-adapter.test.ts`
- `src/main/orchestrator/vendors/sdk-stream/provider-contracts.test.ts`
- `src/main/orchestrator/vision-captioner.test.ts`
- `src/main/orchestrator/build-options.test.ts`
- `src/main/orchestrator/tools/fs-tools.test.ts`
- `src/main/orchestrator/tools/builtin-tools/read-image-url-tool.test.ts`

用例：

- 十八个内置组合及三个自定义协议 → 表中直接列明声明来源、确认状态和预期完整结果。
- 用户声明纯文本、目录识别为图片模型 → 返回 `IMAGE_MODEL_UNSUPPORTED`；不读取图片、不调用模型。
- 已确认禁图的端点组合 → 返回 `IMAGE_TRANSPORT_UNSUPPORTED`；用户模态声明不能覆盖端点禁止。
- 未确认组合 → 分别验证用户明确声明和仅目录推断的约定行为。
- PNG、JPEG、WEBP、GIF、远程 HTTPS 图 → 比较三个协议的完整请求块、顺序、URL、鉴权方式；经 SDK 工厂取得的请求同样符合契约。
- 不支持的 MIME、畸形 data URL、非法 URL → 明确拒绝或按既有约定降级；不将畸形内容作为有效图片发出。
- 三个协议分别转述 → 请求走对应端点，解析对应响应；Responses 和 Anthropic 不调用 `/chat/completions`。
- HTTP 失败、无有效内容、超时、取消 → 稳定失败码；无成功 caption、无成功消息写入，取消后不继续请求。
- 模型明确拒绝图片 → 不对同一端点重复发送图片。
- 越界本地路径、被拒 URL → 保持现有边界；不读取越界内容、不发网络请求。
- 日志含模拟密钥、base64 或服务回显 → 断言日志和 UI 均不包含这些敏感值。

### 步骤 3

测试文件：

- `src/main/channels/dispatcher.test.ts`
- `src/main/channels/message-log.test.ts`
- `src/main/channels/terminal-delivery.test.ts`
- `src/main/channels/agent-policy.test.ts`
- 新增 `src/main/channels/default-profile-flow.test.ts`
- `src/renderer/settings/channels/view-model.test.ts`

新增集成测试使用真实档案解析、bootstrap、dispatcher、日志和发送回执，网络及模型使用可预测替身，避免完全 mock 掉要验证的链路。

用例：

- 各渠道入站文字、默认档案有效 → 一次生成、一次发送，参数及回执正确，完整历史和日志结果符合契约。
- 模型配置缺失 → `profile` 阶段失败；不调用模型；失败提示只有一次；不追加成功 assistant 历史。
- 模型抛错、超时、取消 → 返回对应终态；不展示成功贴纸，不写成功历史。
- 发送回执失败 → 记录 `delivery` 失败及同一诊断编号；不广播成功出站。
- 错误消息包含模拟密钥、URL 查询参数 → 日志、控制台和 UI 不出现敏感值。
- QQ、QQ Bot 群聊且开启渠道工具 → 仍为 Chat、工具为空、不调用命令或工作区写入。
- 日志写盘失败 → 消息链路按实际发送结果结算，不误记为生成成功或重复发送。

### 步骤 4

测试文件：

- 新增 `proactive/proactive-diagnostics.test.ts`
- 新增 `proactive/proactive-diagnostics-ipc.test.ts`
- `proactive-trigger.test.ts`
- `proactive-service.test.ts`
- `proactive-lifecycle.test.ts`
- `proactive-shutdown-delivery.test.ts`
- `application/ipc-contract.test.ts`

用例：

- `preview` → 返回候选及策略结果；模型、投递、状态保存和触发边沿更新均为零次。
- 没有候选 → `candidate` 明确结束；后续阶段全部为 `not_run`。
- 开关关闭、屏幕锁定、普通会话忙、退避、冷却、未回复上限 → 精确断言原因；不调用模型或投递。
- 模型选择沉默 → 状态为 `silent`，不写消息、不发送、不提醒；仅保留当前已有沉默状态更新契约。
- 模型失败、输出无效、超时 → 阶段准确；不启用已下线的预设文案，不伪装提交成功。
- 用户活动、锁屏或关闭发生在生成后 → epoch／取消保护生效，不进入后续投递。
- 定时扫描与真实检查并发 → 仅一个生成；另一个返回 busy，不重复发送。
- production 或未授权发送方调用 → 返回稳定拒绝码；不采集诊断、不访问模型、不写消息。
- 十二小时、两小时、评分 75 等既有临界点两侧 → 保留当前测试结论，不改变策略。
- 默认日志级别下产生摘要 → 临时文件中可读到完整安全摘要；重载后可查询，超出 100 条只保留最近记录。

### 步骤 5

测试文件：

- `proactive/proactive-lifecycle.test.ts`
- `toast/toast-events.test.ts`
- `toast/toast-service.test.ts`
- `application/default-dependencies.test.ts`
- `src/renderer/toast/toast.test.ts`
- 新增 `src/renderer/react/features/chat/pages/proactive-visibility.test.ts`

用例：

- 本地落库成功 → 发布一次带确切消息 ID 的事件；广播与提醒引用同一会话。
- 落库失败或提交已取消 → 不发布 Toast，不标记完整提交。
- 同一消息事件重复到达 → 只展示一次，不重复播放提示音。
- 关闭窗口 → Toast 点击请求打开指定主动会话。
- 当前为另一 Chat／Work／Code 会话 → 显示提醒，当前会话和输入草稿不变；点击后才切换。
- 当前主动会话聚焦 → 刷新后消息实际可见，Toast 被抑制。
- Toast 创建失败 → 消息仍只保存一次，诊断显示提醒失败，不重新生成或投递。
- 用户关闭 Toast、超时、应用退出 → 正确清理计时器和订阅，不删除会话消息。

### 步骤 6

复用飞书发送者、NapCat 白名单及媒体、QQ Bot 被动回复测试。仅在指南揭示未覆盖的当前契约时补相邻测试。

重点核对：

- 飞书未批准发送者 → 不下载媒体、不进入 Agent。
- NapCat 群要求 @ 开启／关闭 → 分别验证非 @ 消息拒绝／允许，白名单始终有效。
- 非回环监听缺 Token → 拒绝启动；Token 错误握手不进入消息处理。
- QQ Bot 不在 openid 白名单 → 不生成回复；超窗及超次数不调用发送 API。
- 媒体大小、分片、缓存时间边界 → 取当前常量，在临界点及两侧断言。
- 指南路径、按钮、默认值和模式限制逐项与源码核对，不用测试静态字符串替代真实接入验收。

## 6. 验证命令

命令来自 `package.json:156` 起及现有测试入口。施工时记录执行提交、退出码、测试归档路径、跳过原因及未验证项。

### 最近测试

```powershell
# 步骤 0
npm test -- src/main/startup
node --test scripts/dev/launch-electron.test.mjs

# 步骤 1
npm test -- src/main/settings/model-settings src/main/chats/chat-ui-ipc src/main/orchestrator/agent-runtime src/main/orchestrator/build-options src/main/channels/bootstrap src/renderer/react/features/chat/hooks/useComposerAttachments

# 步骤 2
npm test -- src/main/orchestrator/image-router src/main/orchestrator/vision-captioner src/main/orchestrator/vendors src/main/orchestrator/tools/fs-tools src/main/orchestrator/tools/builtin-tools/read-image-url-tool src/main/orchestrator/build-options

# 步骤 3
npm test -- src/main/channels src/renderer/settings/channels

# 步骤 4
npm test -- src/main/proactive src/main/application/ipc-contract src/main/application/default-dependencies

# 步骤 5
npm test -- src/main/toast src/main/proactive src/renderer/toast src/renderer/react/features/chat/pages
```

### 类型、边界和构建

```powershell
npm run check:storage-boundary
npm run build:main
npm run build:preload
npm run check:renderer
npm run build:renderer
```

最终集成验证：

```powershell
npm test
npm run build
git diff --check
git status --short
```

`npm test` 只覆盖现有 Vitest 配置集合，不能将其称为包含全部脚本测试；启动器 `.test.mjs` 已单列。使用当前质量要求，不调整超时、阈值或跳过策略。

### 真机与打包验证

1. **先确认步骤 0 已完成。** 创建全新隔离目录，使用当前启动器支持的 `FIREFLY_ISOLATION_ROOT` 启动 `npm run dev`；不使用旧配置和凭据文件。打包验证使用 `npm run package:win:dir`，以 smoke 档案及全新隔离根启动生成的程序。
2. **三模式图片**：分别在 Chat、Work、Code 中测试附件、粘贴和截图；分别设置默认档案、绑定另一档案、切换协议，核对实际请求和诊断。真服务只测试矩阵中有凭据的组合，其余标记未验证。
3. **渠道**：按三份指南从空配置接入，依次验证拒绝发送者、允许发送者、文字、图片及适用媒体、断线重连、模型失败和发送失败。
4. **主动聊天**：内部真实检查按当前策略运行；无候选或被拦截应展示原因。使用隔离测试配置构造可投递场景，核对生成、落库、状态文件和摘要一致。
5. **三个窗口状态**：关闭窗口、停留其他会话、停留主动会话；逐一核对可见消息、提醒、点击目标和不抢占行为。Work、Code 还需确认草稿及运行视图保留。
6. **打包日志**：不依赖开发者控制台，从新数据目录读取主动诊断和渠道日志；记录“已落库但提醒失败”等部分结果。
7. **数据隔离**：确认本次进程实际 `userData`、session、日志均位于新根；不打开真实旧目录采样验证。

## 7. 风险与回退

| 风险 | 控制和回退 |
|---|---|
| 端点能力资料滞后 | 区分已确认与未确认；保留用户明确声明的试发选择；修正矩阵规则不需要改变协议适配器 |
| 未确认组合默认拒绝影响现有可用模型 | 合入前由负责人确认默认行为，逐项记录受影响组合，不静默扩大限制 |
| 档案选择修正改变原有请求目标 | 入口测试覆盖优先级及快照；出错时明确失败，不自动改用另一份凭据 |
| 三协议转述扩大调用面 | 复用现有适配器，保持单次调用、超时和取消；可独立回退转述改动，但不能恢复 Responses 被错误发送到 Chat Completions 的行为 |
| 新诊断泄露内容或增长过快 | 固定字段、无正文摘要、最多 100 次；关闭诊断功能不影响消息服务 |
| 主动提醒重复或抢焦点 | 消息 ID 去重；只有点击才激活；可独立关闭事件订阅，保留落库 |
| 提醒失败被误认作投递失败 | 分开记录 persistence 与 notification；禁止重新生成或重复发送 |
| 平台限制或权限变化 | 发布前核对官方资料，更新指南和受影响契约测试 |
| 数据目录回退导致旧数据被读取 | 1.2.0 的回退版本仍使用新根；禁止通过把路径改回旧根实现回退 |

每个步骤独立回退代码；不删除用户新数据，不执行自动降级迁移。渠道适配器、模型失败和消息发送的外部效果不会因代码回退自动撤销。

## 8. 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

| 决策 | 推荐选项 |
|---|---|
| 1.2.0 新数据目录名称及归属 | 使用 `%APPDATA%\Firefly-1.2.0`；由版本基础主题统一交付，本主题以其为运行前置条件 |
| 未确认图片端点组合的默认行为 | 用户明确声明图片时允许试发；只有目录推断时要求确认，避免错误宣称端点已支持 |
| 是否将转述补齐三个协议 | 补齐，复用现有适配器；不恢复独立视觉模型配置 |
| 明确指定的档案被删除时如何处理 | 明确失败，不自动选择另一供应商；缺省选择仍用默认档案 |
| 内部真实检查是否允许绕过策略 | 不允许；用隔离测试场景构造可投递条件，生产逻辑保持一致 |
| production 是否提供真实主动聊天测试按钮 | 1.2.0 暂不提供；内部档案提供，正式版保留安全诊断记录 |
| 主动消息提醒及预览内容 | 启用现有 Toast，仅显示通用提示；不默认展示消息正文，不自动抢焦点 |
| QQ 群、渠道 Code 和主动投递目标是否扩展 | 本主题不扩展；保持现有模式、权限和主动投递目标，避免将指南补齐变成新渠道能力项目 |
| 真服务验收资源不足时是否发布 | 明确列出未验证组合；已宣称支持的主要组合及三个渠道至少完成一次真实验收，不能以 mock 测试代替 |

## 9. 工作量

按一名熟悉仓库的工程师估算，包含实现、相邻测试及修正，不含等待平台审核或凭据。

| 步骤 | 估计 |
|---|---:|
| 0：新数据根及启动验收 | 1—1.5 人日；若已有交付，仅需约 0.25 人日核对 |
| 1：档案选择及请求快照一致性 | 1.5—2 人日 |
| 2：组合矩阵、三协议转述及回归 | 2.5—4 人日 |
| 3：渠道完整链路及诊断 | 1.5—2 人日 |
| 4：主动聊天阶段诊断及内部入口 | 2—3 人日 |
| 5：主动消息提醒和窗口可见性 | 1.5—2.5 人日 |
| 6：三份指南及真实接入核对 | 1—1.5 人日 |
| 最终集成、打包验证与问题修正 | 1.5—2 人日 |
| **合计** | **约 13—18.5 人日** |

建议顺序：步骤 0 → 1 → 2 → 3 → 4 → 5 → 6。步骤 6 可提前整理文档，但最终参数、截图和验证状态必须来自合入后的实际构建。