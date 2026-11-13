# 渠道与视觉配置施工计划

状态：待施工
规格：无独立规格；依据外部参考文档盘点条目与负责人 2026-11-12 的决定（权限档位与渠道模式见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2、§7.4）。

> 路径说明（2026-11-13）：主进程已按七层重组（#57、#58），本文的文件路径和符号名已换成新位置（如 `src/main/agent/loop/agent-loop.ts`、`runAgentLoop`）。`文件:行号` 里的行号仍是重组前（`39987fc`）的位置，施工时以符号名为准，并在进度文档记录实际行号。

**目标：** 让用户在 Chat、Work、Code 中获得一致、可解释的图片处理行为：使用正确的模型档案，根据供应商、模型输入能力和实际传输协议决定能否发送图片；不能处理时明确说明原因，避免界面判断、后台调用和工具读取各用一套配置。让外部渠道和主动聊天具备可验收的完整链路：渠道消息能够使用默认档案生成并回复，失败结果可以定位到具体阶段（`profile` / `attachments` / `agent` / `delivery`）；主动聊天能够区分未产生候选、策略拦截、模型沉默、生成失败、投递失败、落库成功和提醒失败（`candidate → policy → model → delivery → persistence → notification`）。提供 Firefly 专用的飞书、NapCat、官方 QQ 机器人指南。

| 场景 | Chat | Work | Code |
|---|---|---|---|
| 用户附件、粘贴和截图 | 按当前会话档案处理；未绑定时用默认档案 | 同左，保持任务附件授权 | 同左，保持工作区和附件授权 |
| 直发失败后的图片处理 | 使用本次请求快照，不另换模型 | 同左 | 同左 |
| `read_image`、`read_image_url` | 不因本计划新增工具权限 | 按现有工具可用性处理，默认档案提供视觉配置 | 同左，并保持工作区与网络边界 |
| 外部渠道 | 默认关闭工具时使用 Chat | 仅按现有渠道工具设置进入 Work（1.2.0 规格 §7.4 收紧为只放行 `fs-read`，不接受外部平台审批） | 不新增外部 Code 入口；桌面 Code 不影响渠道选择 |
| 主动聊天 | 写入专用 Chat 会话 | 空闲时可产生 Chat 提醒；不插入 Work 会话 | 空闲时可产生 Chat 提醒；不插入 Code 会话 |
| 正在运行或审批 | 保留已有 busy、取消保护 | 同左 | 同左 |

**架构：** 采用“统一档案选择、统一图片路由、沿用现有渠道与主动服务、补诊断和提醒”的增量方案。在 `src/main/model/config/model-settings.ts` 增加严格的 `resolveRunModelSelection(settings, { boundProfileId?, pendingProfileId? })`，一次请求只捕获一份选择结果快照并贯穿发送策略判断、附件处理、Agent 请求与直发失败转述。在 `src/main/model/providers/image-transport-policy.ts` 与 `image-router.ts` 将模型能力、端点协议能力（18 个内置组合 + 3 个自定义协议）和序列化三者分离，并将 `vision-captioner.ts` 改为复用现有 OpenAI、Anthropic、Responses 适配器。渠道在 `LogEntry` 增加可选脱敏 `diagnostic`（同一入站请求共用 `attemptId`）。主动聊天新增 `proactive-diagnostics.ts` 与内部受控 IPC（`proactive:diagnose`、`proactive:diagnostics:get`，仅非 production 可调用），通过现有文件 sink 保留最近 100 次安全摘要，并在本地落库成功后通过新增 `ToastKind: "proactive-message"` 与焦点/会话感知刷新保证可见性。

**不改的东西：**
- 仅沿用 Firefly 当前模块和接口，不复制外部参考文档中的实现。
- 不新增依赖、检查工具或 CI 阈值，不将历史验证记录当作当前通过证明。
- **已完成且移出重新实现范围的能力（仅补测试或复用）**：
  - Anthropic 图片转换（`src/main/model/providers/anthropic-adapter.ts:35,97` 的 `toAnthropicContent`）与 Responses 图片转换（`responses-adapter.ts:33` 的 `toUserContentBlocks`）已完成，原则上只补测试，只有测试证明存在缺陷时才修改对应适配器。
  - 模型输入能力统一入口 `src/main/model/providers/multimodal.ts::resolveInputModalities` 与不传档案 ID 时的通用 `resolveModelSettingsProfile`（`model-settings.ts:283–307`）回退语义保持不变；新入口显式采用严格选择。
  - 渠道失败日志与终态回复（`features/channels/dispatcher.ts::processIncoming`、`terminalReply`、`features/channels/message-log.ts::LogEntry`、`channels:log:get`、`channels:log:clear`）已存在，不新增第二套渠道日志或重复实现失败回复。
  - 主动聊天现有策略（两小时全局间隔、十二小时后续间隔、75 分门槛、两次未回复上限，见 `proactive-policy.ts:9,10,12,48`）、冷却、评分、天气场景、返回事件检测与用户时区生成（`proactive-lifecycle.ts:115`、`proactive-trigger.ts:302`）保持当前行为，不重新开启历史调参。
  - 保留 `captionImage` 的字符串接口供现有工具使用；不新增独立视觉模型配置。
  - 本主题不扩展 QQ 群、渠道 Code 和主动投递目标。

## 现状

本计划以 `c991111efa68087b9d625868179c03fea1b83e14` 为基线。实际工作区为 detached HEAD，`dev/firefly-1.2.0` 包含该提交，工作树干净。本次仅进行了只读核对，没有创建文件、修改代码、运行测试或构建；以下验证均为施工阶段要求。

### 模块边界

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

### 图片转换和能力解析已有实现

1. **Anthropic 图片转换已完成，移出新增功能范围。**
   `src/main/model/providers/anthropic-adapter.ts:35` 的 `toAnthropicContent` 已将图片转换为 `source.type="base64"` 或 `"url"`，对不支持的嵌入式 MIME 降级为文本；用户消息在该文件 `:97` 调用转换。现有测试覆盖 PNG、远程 URL、JPEG、WEBP、GIF 和不支持的 MIME，见 `anthropic-adapter.test.ts:139`—`:147`。
2. **模型输入能力已有统一入口。**
   `src/main/model/providers/multimodal.ts::resolveInputModalities` 根据档案声明、内置目录、未知保守回退判断图片能力；`src/main/model/config/model-settings.ts:283` 的 `resolveModelSettingsProfile` 将结果展开为 `multimodal`。目录位于 `model/providers/model-modalities.catalog.ts:22`。
3. **当前直发路由只检查 `multimodal`。**
   `src/main/model/vision/image-router.ts:36`—`:43` 没有检查供应商端点与传输组合。`model/providers/capabilities.ts::PROVIDER_CAPABILITIES` 已列出供应商支持的协议，但该字段不能单独证明图片能力。缺口是组合覆盖及端点能力判定，不能据此宣称所有组合可用。
4. **传输选择已有统一函数。**
   `model/providers/transport-detector.ts::resolveTransport` 优先使用 `explicitTransport`，否则使用供应商默认协议；`model/providers/index.ts::getAdapterForConfig` 按实际协议创建适配器。Responses 图片转换已在 `responses-adapter.ts:33` 的 `toUserContentBlocks` 中实现。

### 默认档案解析已完成，入口之间仍有不一致

1. **不传档案 ID 时解析默认档案已经完成。**
   `model-settings.ts:283`—`:307` 已实现默认档案展开，没有默认 ID 时由 `model-catalog.ts::resolveDefaultModelProfile` 选择首个档案。`model-settings.test.ts:57` 起已有显式、默认、回退和不存在 ID 的测试，不再安排重做。
2. **渠道主链路已经调用默认解析。**
   `features/channels/bootstrap.ts:104` 使用 `resolveModelSettingsProfile(saved)` 判断图片能力；Agent 构建通过 `agent/runtime/agent-runtime.ts:165` 展开档案。启用记忆入口时还会传入默认档案 ID，并保留 `MEMORY_RUN_PROFILE_DENIED` 等拒绝条件，见 `bootstrap.ts::run`。
3. **图片发送策略存在静态不一致。**
   `features/sessions/chat-ui-ipc.ts:184` 起的 `CHAT_GET_IMAGE_SEND_STRATEGY` 先读取原始设置，仅在会话绑定档案时展开；未绑定时没有按注释所述展开默认档案。相邻 `CHAT_CAPTION_IMAGE` 在 `:173` 则明确使用默认档案。两者可能对同一图片给出不同判断。
4. **直发失败转述也可能换用另一份档案。**
   `agent/runtime/agent-runtime.ts:193` 起的 `captionImageForFallback` 重新读取默认档案，没有使用产生本次请求的档案快照。
5. **转述配置与实际传输不一致。**
   `image-router.ts:64` 仅排除显式 Anthropic，允许 Responses；但 `vision-captioner.ts::buildChatCompletionsUrl` 固定拼接 `/chat/completions`，`VisionConfig` 也不包含供应商和协议。未显式填写协议的 Anthropic 默认档案同样不能靠该判断可靠识别。

这些是静态源码证据，尚未通过真实服务复现。

### 渠道失败日志和终态回复已有实现

- `features/channels/dispatcher.ts::processIncoming` 已记录 `incoming`、Agent 异常和发送失败；`terminalReply` 已区分成功、超时、取消、运行失败以及部分输出。
- `features/channels/message-log.ts::LogEntry` 已有 `dir: "incoming" | "outgoing" | "error"`，日志位于当前 `userData/channels/log.jsonl`。
- 现有 `channels:log:get`、`channels:log:clear` 可用于查看和清理日志，见 `shared/ipc-channels.ts:38`、`:39`。

因此，不新增第二套渠道日志或重复实现失败回复；补充档案到发送回执的集成测试、阶段关联信息和错误脱敏。当前异常分支直接记录 `Error.message`，证据见 `dispatcher.ts::processIncoming`，不能假定异常内容天然适合写盘或展示。

### 主动聊天已有策略、阶段事件和取消保护

- 启动接线已存在，见 `app/background.ts:206`。
- 服务已有 `candidate_blocked`、`model_silent`、`commit_blocked`、`commit_cancelled`、`message_committed` 等事件，见 `proactive-service.ts::createProactiveChatService`。
- 触发器已有内部 `evaluateNow`，见 `proactive-trigger.ts:53`、`:395`，但返回 `Promise<void>`，尚不能作为阶段化诊断结果。
- 本地时间已按用户时区生成，见 `proactive-lifecycle.ts:115`、`proactive-trigger.ts:302`；不将外部参考文档中的时区疑点直接认定为当前缺陷。
- 当前策略包含两小时全局间隔、十二小时后续间隔、75 分门槛和两次未回复上限，见 `proactive-policy.ts:9`、`:10`、`:12`、`:48`。
- 本地投递已写入专用会话并广播变化，见 `proactive-lifecycle.ts:183`—`:199`；当前没有在该路径发布主动消息提醒事件。
- 阶段事件仍通过 `console.log` 输出，见 `proactive-lifecycle.ts:335`、`proactive-trigger.ts:280`。文件日志使用独立的 logger sink，默认级别为 `warn`，见 `base/logging/logger.ts::resolveDefaultLevel`、`initializeMainFileLogging`。不能保证这些阶段事件在打包版落盘。

### 提醒设施已有，无须另建通知系统

`platform/toast/toast-service.ts::createToastService` 已支持通知档、去重、音效合并、点击激活和自动消失；共享 `ToastTarget` 已支持指定会话，见 `shared/toast-types.ts`。当前 `ToastKind` 没有主动消息类型。

聊天页收到会话变化后主要刷新当前模式列表，见 `ChatPage.tsx:337` 起的 `store.onChanged(refresh)`。仅有落库和列表广播，尚不足以证明关闭窗口、查看其他会话、正在查看主动会话三种状态下均能看到消息。

### 三个渠道实现已有，缺少产品指南

`git ls-tree -r --name-only HEAD docs/user-guide` 无输出。

| 渠道 | 已有实现和必须反映的差异 |
|---|---|
| 飞书 | `features/channels/adapters/feishu/index.ts::rebuildChannel` 已使用 WebSocket，仅处理 `p2p`，且在下载媒体前调用 `admitSender`。`settings-store.ts:37` 默认关闭任意私聊放行，不能写成“没有白名单”。 |
| NapCat | `napcat-adapter.ts:31` 的 `isQqEventAllowed` 检查私聊、群白名单；群是否要求 @ 取决于 `groupRequireMention`。监听路径见 `onebot-reverse-ws.ts:10`，非回环无 Token 会拒绝，见 `:105`。 |
| 官方 QQ 机器人 | `qqbot-adapter.ts:15` 按 openid 放行；被动回复窗口和次数由 `REPLY_WINDOW_MS`、`REPLY_SEQ_LIMIT` 限制；出站能力当前仅文本。入站下载有 8 MiB 限制，见 `:223`。平台规则需要发布前重新核对。 |

外部渠道目前按 `features/channels/agent-policy.ts:12` 选择 Chat 或 Work；QQ、QQ Bot 群聊强制 Chat 且不暴露工具，没有独立 Code 渠道执行入口。

### 新数据目录尚未满足

`base/identity/runtime-profile.ts:55` 的 production 路径仍为 `%APPDATA%\Firefly`，与 `README.md:121`、`DEVELOPMENT.md:27` 一致。源码开发启动器也有既有默认隔离根，见 `scripts/dev/launch-electron.mjs::DEFAULT_ISOLATION`。因此，新目录必须作为本主题运行验收的前置条件；不能直接启动当前 production 档案进行测试。

## 全局约束

- **1.2.0 数据目录与隔离要求**：1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`（负责人 2026-11-12 决定），不读取、不迁移 1.1.x 用户数据。所有指南从全新 1.2.0 配置开始，不指导复制旧目录。
- **权限档位与渠道工具边界**：用户可选权限档位只有三档（只读 `read-only`、请求审批 `per-action`、完全访问 `full`），1.2.0 删除旧值 `project-read-only` 和 `scoped`（见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2）。外部渠道默认在 Chat 模式处理，不挂任何工具；按会话开启 Work 时，按 1.2.0 规格 §7.4 收紧为只放行 `fs-read` 风险的工具，且审批永远不能在外部平台上完成。
- **新增及改变行为先写失败测试**：已经存在且符合要求的能力仅补覆盖，不重新实现。本计划中的新增文件、类型、错误码和 IPC 均为拟新增设计，区别于现有接口。
- **安全与脱敏边界**：渠道诊断与主动聊天诊断仅允许固定字段，不写密钥、鉴权头、图片 base64、完整请求体、原始服务响应、带查询参数的 URL、提示词、记忆正文或模型原始回复。主动消息 Toast 默认文案为“流萤发来了一条主动消息”，不默认展示私密正文，不自动抢焦点。
- **官方资料核验纪律**：本次核对的官方资料支持 Anthropic 图片源格式、OpenAI 图片输入格式，以及 MiniMax 当前 Anthropic 接口的图片支持；不能沿用旧文档中整个供应商一律禁图的判断（参考：[Anthropic 视觉文档](https://platform.claude.com/docs/en/build-with-claude/vision)、[OpenAI 图片输入文档](https://developers.openai.com/api/docs/guides/images-vision)、[MiniMax Anthropic 接口文档](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)）。真服务验收资源不足时明确列出未验证组合；已宣称支持的主要组合及三个渠道至少完成一次真实验收，不能以 mock 测试代替。
- **测试断言纪律（遵循 `AGENTS.md` 的 12 条测试断言规则）**：所有测试遵循 `AGENTS.md`：稳定对象使用完整比较；失败同时断言没有越权调用、成功写入或泄露；时间边界使用假定时器并恢复；文件系统使用临时目录并清理。环境缺失必须显式跳过并记录原因。

## 文件清单

### 新建

| 文件 | 用途 | 施工包 |
|---|---|---|
| `src/main/model/providers/image-transport-policy.ts` | 18 个内置组合 + 3 个自定义协议的端点图片能力判定 | C |
| `src/main/model/providers/image-transport-policy.test.ts` | 组合矩阵表驱动测试 | C |
| `docs/qa/1.2.0-image-channel-matrix.md` | 组合矩阵与真实服务验证记录 | C、G |
| `src/shared/channel-diagnostics.ts` | 渠道诊断固定字段契约 | D |
| `src/main/features/channels/default-profile-flow.test.ts` | 默认档案到发送回执的集成测试 | D |
| `src/shared/proactive-diagnostics.ts` | 主动聊天阶段诊断结果契约 | E |
| `src/main/features/proactive/proactive-diagnostics.ts` | 阶段摘要与最近 100 次文件持久化 | E |
| `src/main/features/proactive/proactive-diagnostics.test.ts` | 阶段摘要测试 | E |
| `src/main/features/proactive/proactive-diagnostics-ipc.ts` | 内部受控诊断 IPC | E |
| `src/main/features/proactive/proactive-diagnostics-ipc.test.ts` | IPC 门禁测试 | E |
| `src/renderer/react/features/chat/pages/proactive-visibility.test.ts` | 三种窗口/会话状态可见性测试 | F |
| `docs/user-guide/feishu.md` | 飞书接入指南（若文档与工程计划已创建则核对合并补充） | G |
| `docs/user-guide/napcat-onebot.md` | NapCat 接入指南（同上） | G |
| `docs/user-guide/qqbot-official.md` | 官方 QQ 机器人接入指南（同上） | G |

### 修改

| 文件 | 施工包 |
|---|---|
| `src/main/base/identity/runtime-profile.ts`、`src/main/base/identity/runtime-profile.test.ts` | A |
| `src/main/base/identity/runtime-profile-documentation.test.ts` | A |
| `scripts/dev/launch-electron.mjs`、`scripts/dev/launch-electron.test.mjs` | A |
| `README.md`、`DEVELOPMENT.md`（若版本基础主题已完成此项，只核对提交及验收记录，不重复修改；`README.md` 在 G 中补渠道指南链接） | A、G |
| `src/main/model/config/model-settings.ts`、`src/main/model/config/model-settings.test.ts`、`src/main/model/config/model-settings.vision.test.ts` | B |
| `src/main/features/sessions/chat-ui-ipc.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts` | B |
| `src/preload/index.ts` | B、E |
| `src/shared/ipc-channels.ts` | E |
| `src/shared/toast-types.ts` | F |
| `src/renderer/react/features/chat/hooks/useComposerAttachments.ts`、`useComposerAttachments.test.ts` | B |
| `src/main/agent/runtime/build-options.ts`、`src/main/agent/runtime/build-options.test.ts` | B、C |
| `src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/agent-runtime.test.ts` | B |
| `src/main/model/vision/image-router.ts`、`src/main/model/vision/image-router.test.ts` | C |
| `src/main/model/vision/vision-captioner.ts`、`src/main/model/vision/vision-captioner.test.ts` | C |
| `src/main/model/providers/*-adapter.test.ts`（三个现有适配器测试）、`src/main/model/providers/sdk-stream/provider-contracts.test.ts` | C |
| `src/main/agent/runtime/image-caption.ts` | C |
| `src/main/agent/tools/fs-tools.ts`、`src/main/agent/tools/fs-tools.test.ts` | C |
| `src/main/agent/tools/builtin-tools/read-image-url-tool.ts`、`read-image-url-tool.test.ts` | C |
| `src/main/features/channels/bootstrap.ts`、`src/main/features/channels/bootstrap.test.ts` | B、D |
| `src/main/features/channels/message-log.ts`、`src/main/features/channels/message-log.test.ts` | D |
| `src/main/features/channels/dispatcher.ts`、`src/main/features/channels/dispatcher.test.ts` | D |
| `src/main/features/channels/terminal-delivery.test.ts`、`src/main/features/channels/agent-policy.test.ts` | D |
| `src/renderer/settings/channels/panel.ts`、`src/renderer/settings/channels/view-model.ts`、`view-model.test.ts` | D |
| `src/renderer/settings/shared/types.ts` | D、E |
| `src/renderer/settings/settings.ts`、`src/renderer/settings/index.html` | E |
| `src/main/features/proactive/proactive-trigger.ts`、`src/main/features/proactive/proactive-trigger.test.ts` | E |
| `src/main/features/proactive/proactive-service.ts`、`src/main/features/proactive/proactive-service.test.ts` | E |
| `src/main/features/proactive/proactive-lifecycle.ts`、`src/main/features/proactive/proactive-lifecycle.test.ts` | E、F |
| `src/main/features/proactive/proactive-shutdown-delivery.test.ts` | E |
| `src/main/app/default-dependencies.ts`、`src/main/app/default-dependencies.test.ts` | E、F |
| `src/main/app/ipc-contract.test.ts` | E |
| `src/main/platform/interaction/toast-events.ts`、`src/main/platform/interaction/toast-events.test.ts` | F |
| `src/main/platform/toast/toast-service.ts`、`src/main/platform/toast/toast-service.test.ts` | F |
| `src/renderer/toast/toast.ts`、`src/renderer/toast/toast.test.ts` | F |
| `src/renderer/react/features/chat/pages/ChatPage.tsx` | F |
| `src/renderer/settings/i18n/zh-CN.json` | B、D、E |
| `src/renderer/react/i18n/zh-CN.json` | B、F |
| 飞书、NapCat、QQ Bot 现有适配器测试（仅在指南核对揭示未覆盖的当前契约时补充） | G |

## 施工包

建议合并顺序：施工包 A → 施工包 B → 施工包 C → 施工包 D → 施工包 E → 施工包 F → 施工包 G。每包按“新增失败测试 → 最小实现 → 最近测试 → 类型检查”推进，独立形成可审查 PR。施工包 G 可提前整理文档草稿，但最终参数、截图和验证状态必须来自合入后的实际构建。

### 施工包 A：建立 1.2.0 数据隔离前置条件

依赖：无（若版本基础主题已完成此项，本包只核对提交及验收记录，不重复修改）
**改动文件：** `src/main/base/identity/runtime-profile.ts`、`src/main/base/identity/runtime-profile.test.ts`、`src/main/base/identity/runtime-profile-documentation.test.ts`、`scripts/dev/launch-electron.mjs`、`scripts/dev/launch-electron.test.mjs`、`README.md`、`DEVELOPMENT.md`（非测试文件 4 个）

**任务：**

- [ ] A1 将 production 数据根切换至 `%APPDATA%\Firefly-1.2.0`，不读取、不迁移旧目录
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`、`src/main/base/identity/runtime-profile-documentation.test.ts`：新目录不存在、临时根中存在模拟旧目录 `%APPDATA%\Firefly` → 返回新根 `%APPDATA%\Firefly-1.2.0`，启动后配置为空；旧目录没有读取、复制或写入。
  - 实现：修改 `src/main/base/identity/runtime-profile.ts` 将 production 解析到 `%APPDATA%\Firefly-1.2.0`，保持路径预检和隔离保护；更新 `README.md`、`DEVELOPMENT.md` 中的数据目录说明。
  - 验证：`npm test -- src/main/startup`
- [ ] A2 隔离开发启动器默认根，保证不同运行档案互不混用
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`、`scripts/dev/launch-electron.test.mjs`：同时启动不同运行档案（development / test / smoke / production） → `userData`、session、日志路径互不混用，开发默认隔离根与旧开发数据分离。
  - 实现：修改 `scripts/dev/launch-electron.mjs` 的 `DEFAULT_ISOLATION`，使默认开发隔离根与旧开发数据分离。
  - 验证：`node --test scripts/dev/launch-electron.test.mjs`；`npm test -- src/main/startup`
- [ ] A3 保持隔离根越界、重叠与 junction 逃逸的拒绝行为
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`：隔离根越界、与正式数据根重叠、junction 逃逸 → 断言现有稳定错误码；路径应用及设置加载均未执行。
  - 实现：仅在测试证明新根破坏既有预检时修改 `src/main/base/identity/runtime-profile.ts` 的路径预检；不放宽任何拒绝条件。
  - 验证：`npm test -- src/main/startup`
- [ ] A4 重启同一 1.2.0 档案只读取自身新数据
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`：重启同一 1.2.0 档案 → 读取自身新数据，不访问模拟旧目录（以临时目录 + 访问记录替身断言旧目录访问次数为 0）。该用例预期立即通过，作为回归锁定。
  - 实现：无额外实现；若失败，修正 `src/main/base/identity/runtime-profile.ts` 的根解析使其幂等。
  - 验证：`npm test -- src/main/startup`

**验收：** 正式档案与开发启动器默认路径均与 1.1.x 隔离；路径越界与重叠拒绝测试通过。
**回退：** 1.2.0 的回退版本仍使用新根 `%APPDATA%\Firefly-1.2.0`；禁止通过把路径改回旧根实现回退。
**工作量：** 1—1.5 人日（若已有交付，仅需约 0.25 人日核对）

---

### 施工包 B：统一图片入口的档案选择与请求快照

依赖：施工包 A
**改动文件：** `src/main/model/config/model-settings.ts`、`src/main/model/config/model-settings.test.ts`、`src/main/model/config/model-settings.vision.test.ts`、`src/main/features/sessions/chat-ui-ipc.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts`、`src/preload/index.ts`、`src/renderer/react/features/chat/hooks/useComposerAttachments.ts`、`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`、`src/main/agent/runtime/build-options.ts`、`src/main/agent/runtime/build-options.test.ts`、`src/main/agent/runtime/agent-runtime.ts`、`src/main/agent/runtime/agent-runtime.test.ts`、`src/main/features/channels/bootstrap.ts`、`src/main/features/channels/bootstrap.test.ts`、`src/renderer/settings/i18n/zh-CN.json`、`src/renderer/react/i18n/zh-CN.json`（非测试文件 9 个）

本包落地的设计契约：

- 在 `src/main/model/config/model-settings.ts` 增加统一严格选择函数：
  `resolveRunModelSelection(settings, { boundProfileId?, pendingProfileId? })`
  结果为成功的 `{ profileId, settings }`，或稳定错误码：
  1. 桌面图片：会话绑定档案（`boundProfileId`） → 欢迎页暂选档案（`pendingProfileId`） → 默认档案。
  2. 渠道、主动聊天以及现有默认档案视觉工具：默认档案。
  3. 明确提供但已删除的档案返回 `MODEL_PROFILE_NOT_FOUND`，不默默使用另一家供应商。
  4. 完全没有档案时返回 `MODEL_PROFILE_REQUIRED`，提示“请先在「设置 → API 设置」创建并选择默认模型档案。”
  5. 不改变现有 `resolveModelSettingsProfile` 的通用回退语义；新入口显式采用严格选择。
- 一次请求只捕获一份选择结果。图片能力判断、附件处理、Agent 请求和直发失败后的转述（`captionImageForFallback`）均使用该快照；请求期间修改默认档案仅影响下一次请求。
- `chat:get-image-send-strategy` 与 `chat:caption-image` 统一支持 `{ sessionId?, modelProfileId? }`；发送策略增加明确的 `reject` 分支，渲染端收到拒绝后停止图片转述及发送，不再将拒绝伪装成可用的 caption 路径。
- 图片 IPC 沿用 `chat:get-image-send-strategy`、`chat:caption-image`、`chat:get-image-preview` 三个现有通道，不新增通道；`captionImage` 继续携带文件路径和标注状态。
- 新增文案进入对应中文 i18n 文件（设置页使用 `src/renderer/settings/i18n/zh-CN.json`，聊天页使用 `src/renderer/react/i18n/zh-CN.json`；错误码保持稳定，用户文案不依赖字符串匹配）：
  - “请先在「设置 → API 设置」创建并选择默认模型档案。”
  - “当前模型不支持图片输入。”
  - “当前模型与协议组合尚未确认支持图片，请核对该档案的输入类型。”
  - “图片处理失败，诊断编号：{attemptId}。”

**任务：**

- [ ] B1 新增 `resolveRunModelSelection`，默认档案完整时不使用顶层镜像字段
  - 先写的测试：`src/main/model/config/model-settings.test.ts`、`src/main/model/config/model-settings.vision.test.ts`：顶层镜像字段为空、默认档案完整 → 发送策略、转述和渠道请求全部使用默认档案的完整配置（完整对象比较），不使用顶层镜像地址或凭据。
  - 实现：修改 `src/main/model/config/model-settings.ts` 新增 `resolveRunModelSelection(settings, { boundProfileId?, pendingProfileId? })`，返回 `{ profileId, settings }` 或稳定错误码；不改动 `resolveModelSettingsProfile`。
  - 验证：`npm test -- src/main/platform/settings/model-settings`
- [ ] B2 按“会话绑定 → 欢迎页暂选 → 默认”优先级选择档案，三模式共用表驱动
  - 先写的测试：`src/main/model/config/model-settings.test.ts`、`src/main/features/sessions/chat-ui-ipc.test.ts`：会话绑定 A、欢迎页暂选 B、默认 C → 按 `A → B → C` 优先级分别选中；Chat / Work / Code 三个模式使用相同表驱动用例。
  - 实现：在 `resolveRunModelSelection` 中实现优先级；渠道、主动聊天以及现有默认档案视觉工具只走默认档案分支。
  - 验证：`npm test -- src/main/platform/settings/model-settings src/main/features/sessions/chat-ui-ipc`
- [ ] B3 显式档案已删除时返回 `MODEL_PROFILE_NOT_FOUND`，不换供应商
  - 先写的测试：`src/main/model/config/model-settings.test.ts`、`src/main/agent/runtime/agent-runtime.test.ts`：显式指定的档案已删除 → 返回 `MODEL_PROFILE_NOT_FOUND`；模型调用、转述、附件读取及成功消息写入均未发生（替身调用次数为 0）。
  - 实现：`resolveRunModelSelection` 对显式但不存在的 ID 直接返回错误码；`agent-runtime.ts` 收到错误码时在附件处理前终止。
  - 验证：`npm test -- src/main/platform/settings/model-settings src/main/agent/runtime/agent-runtime`
- [ ] B4 完全没有档案时返回 `MODEL_PROFILE_REQUIRED`，不发请求、不自动建档
  - 先写的测试：`src/main/model/config/model-settings.test.ts`、`src/main/features/channels/bootstrap.test.ts`：没有任何档案 → 返回 `MODEL_PROFILE_REQUIRED`；不发网络请求、不保存自动生成的档案（设置存储写入次数为 0）。
  - 实现：`resolveRunModelSelection` 无档案分支返回 `MODEL_PROFILE_REQUIRED`；`src/main/features/channels/bootstrap.ts` 改用严格选择并把错误码交给渠道 `profile` 阶段。
  - 验证：`npm test -- src/main/platform/settings/model-settings src/main/features/channels/bootstrap`
- [ ] B5 一次请求只捕获一份档案快照，直发失败转述沿用该快照
  - 先写的测试：`src/main/agent/runtime/agent-runtime.test.ts`、`src/main/agent/runtime/build-options.test.ts`：请求开始后默认档案变化 → 当前请求及 `captionImageForFallback` 直发失败处理仍使用请求开始时的原快照；下一请求使用新默认档案。
  - 实现：修改 `src/main/agent/runtime/build-options.ts`、`src/main/agent/runtime/agent-runtime.ts`，将选择结果作为请求级 `ModelSettingsLite` 快照传入，`captionImageForFallback`（`agent-runtime.ts:193`）接收本次 `ModelSettingsLite` 快照而不再重新读取默认档案。
  - 验证：`npm test -- src/main/agent/runtime/agent-runtime src/main/agent/runtime/build-options`
- [ ] B6 统一 `chat-ui-ipc.ts` 两个图片入口，渲染端处理 `reject` 分支并展示中文原因
  - 先写的测试：`src/main/features/sessions/chat-ui-ipc.test.ts`、`src/renderer/react/features/chat/hooks/useComposerAttachments.test.ts`：`CHAT_GET_IMAGE_SEND_STRATEGY` 与 `CHAT_CAPTION_IMAGE` 传入相同 `{ sessionId?, modelProfileId? }` 时得出完全一致的档案与策略；UI 收到 `reject` → 展示对应中文原因；不调用 `captionImage`，也不发送图片。
  - 实现：修改 `src/main/features/sessions/chat-ui-ipc.ts`（`:173`、`:184` 两处统一走 `resolveRunModelSelection`）、`src/preload/index.ts`、`src/renderer/react/features/chat/hooks/useComposerAttachments.ts`，并在两个 `zh-CN.json` 补齐上列文案。
  - 验证：`npm test -- src/main/features/sessions/chat-ui-ipc src/renderer/react/features/chat/hooks/useComposerAttachments`；`npm run build:main`；`npm run build:preload`；`npm run check:renderer`
- [ ] B7 保留记忆入口拒绝，统一档案选择不绕过 ingress 或附件 grant
  - 先写的测试：`src/main/features/channels/bootstrap.test.ts`：保留现有记忆入口拒绝测试（如 `MEMORY_RUN_PROFILE_DENIED`） → 不因统一档案选择绕过 ingress 或附件 grant；拒绝时模型与附件读取调用次数为 0。
  - 实现：`src/main/features/channels/bootstrap.ts::run` 在调用严格选择前后保持现有拒绝条件顺序。
  - 验证：`npm test -- src/main/features/channels/bootstrap`

**验收：** 界面图片策略、转述回退与渠道入站对同一会话/默认配置始终选中同一份模型档案快照；删除档案或无档案时明确失败且无越权请求。
**回退：** revert 本包提交；退回原有 `resolveModelSettingsProfile` 调用方式。
**工作量：** 1.5—2 人日

---

### 施工包 C：落实图片组合矩阵及三协议一致转述

依赖：施工包 B
**改动文件：** `src/main/model/providers/image-transport-policy.ts`、`src/main/model/providers/image-transport-policy.test.ts`、`src/main/model/vision/image-router.ts`、`src/main/model/vision/image-router.test.ts`、`src/main/model/vision/vision-captioner.ts`、`src/main/model/vision/vision-captioner.test.ts`、`src/main/agent/runtime/image-caption.ts`、`src/main/agent/tools/fs-tools.ts`、`src/main/agent/tools/fs-tools.test.ts`、`src/main/agent/tools/builtin-tools/read-image-url-tool.ts`、`src/main/agent/tools/builtin-tools/read-image-url-tool.test.ts`、`src/main/agent/runtime/build-options.ts`、`src/main/agent/runtime/build-options.test.ts`、三个现有 `src/main/model/providers/*-adapter.test.ts`、`src/main/model/providers/sdk-stream/provider-contracts.test.ts`、`docs/qa/1.2.0-image-channel-matrix.md`（非测试文件 8 个）

本包落地的设计契约：

- 新增 `src/main/model/providers/image-transport-policy.ts`，保存有官方资料依据的端点限制及判定函数（不复制一份模型模态目录），覆盖当前 `PROVIDER_CAPABILITIES` 的全部 18 个声明组合以及自定义端点的 3 个协议：
  - `minimax`：Anthropic、OpenAI、Responses
  - `deepseek`：OpenAI、Anthropic、Responses
  - `glm`：OpenAI、Anthropic
  - `kimi`：OpenAI
  - `qwen`：OpenAI、Responses
  - `chatgpt`：OpenAI、Responses
  - `claude`：Anthropic
  - `mimo`：OpenAI、Anthropic、Responses
  - `openrouter`：OpenAI
- 判定规则（负责人已批准未确认组合默认行为）：
  | 条件 | 结果 |
  |---|---|
  | 模型声明或解析结果为纯文本 | `IMAGE_MODEL_UNSUPPORTED`（“当前模型不支持图片输入。”） |
  | 当前端点组合已确认不支持图片 | `IMAGE_TRANSPORT_UNSUPPORTED` |
  | 模型支持图片且组合已确认支持 | 直发（`direct`） |
  | 组合未确认，用户明确声明图片输入 | 允许试发，失败如实返回 |
  | 组合未确认，仅由目录推断图片能力 | `IMAGE_TRANSPORT_UNVERIFIED`（“当前模型与协议组合尚未确认支持图片，请核对该档案的输入类型。”） |
  | 自定义端点 | 使用显式协议和用户声明，不根据 URL 猜测供应商 |
- 保留 `ImageSource`，扩充 `resolveImageRoute` 与 `resolveCaptionVisionConfig`：`CaptionVisionConfig` 携带供应商（`provider`）和实际协议（`transport`），不能只返回地址、密钥、模型。
- `vision-captioner.ts` 改为使用 `getAdapterForConfig`、`buildRequest`、`parseResponse` 统一支持 OpenAI、Anthropic、Responses 三个现有协议，沿用现有非流式调用方式、视觉超时策略和输出预算。保留 `captionImage` 的字符串接口供现有工具使用；内部增加结构化结果供 `captionImageSafe` 返回错误码。明确不支持图片或服务已明确拒绝图片时，不向同一端点重复发送同一图片，不进行递归转述重试。

**任务：**

- [ ] C1 新建 `image-transport-policy.ts`，18 个内置组合与 3 个自定义协议表驱动判定，并建立矩阵文档
  - 先写的测试：`src/main/model/providers/image-transport-policy.test.ts`、`src/main/model/vision/image-router.test.ts`：18 个内置组合及 3 个自定义协议表驱动 → 表中直接列明声明来源、确认状态和预期完整路由结果（完整对象比较）。
  - 实现：新建 `src/main/model/providers/image-transport-policy.ts`（每行记录模型样例或匹配范围、能力来源、协议、预期 wire 结构、官方依据及真实服务验证状态，不把“适配器能生成请求”标成“服务已验证可用”）；新建 `docs/qa/1.2.0-image-channel-matrix.md`；修改 `src/main/model/vision/image-router.ts` 让 `resolveImageRoute` 输入包含 `provider`、`model`、实际 `Transport`、解析后的输入模态及声明来源，拒绝结果增加稳定 `code` 并保留现有 `reason`。
  - 验证：`npm test -- src/main/model/providers/image-transport-policy src/main/agent/runtime/image-router`
- [ ] C2 纯文本模型声明优先于目录推断，返回 `IMAGE_MODEL_UNSUPPORTED`
  - 先写的测试：`src/main/model/vision/image-router.test.ts`：用户声明纯文本、目录识别为图片模型 → 返回 `IMAGE_MODEL_UNSUPPORTED`；不读取图片、不调用模型。
  - 实现：`image-router.ts` 继续使用 `resolveInputModalities` 并保留用户声明优先级，先判模型能力再判端点能力。
  - 验证：`npm test -- src/main/agent/runtime/image-router`
- [ ] C3 已确认禁图的端点组合返回 `IMAGE_TRANSPORT_UNSUPPORTED`，用户声明不能覆盖
  - 先写的测试：`src/main/model/providers/image-transport-policy.test.ts`：已确认禁图的端点组合 → 返回 `IMAGE_TRANSPORT_UNSUPPORTED`；用户模态声明不能覆盖端点禁止。
  - 实现：`image-transport-policy.ts` 的“已确认不支持”分支先于用户声明判定。
  - 验证：`npm test -- src/main/model/providers/image-transport-policy`
- [ ] C4 未确认组合：用户明确声明允许试发，仅目录推断返回 `IMAGE_TRANSPORT_UNVERIFIED`
  - 先写的测试：`src/main/model/providers/image-transport-policy.test.ts`、`src/main/model/vision/image-router.test.ts`：未确认组合 → 用户明确声明图片时允许试发（失败如实返回）；仅目录推断时返回 `IMAGE_TRANSPORT_UNVERIFIED`；自定义端点不根据 URL 猜测供应商。
  - 实现：按负责人批准的默认行为实现未确认分支。
  - 验证：`npm test -- src/main/model/providers/image-transport-policy src/main/agent/runtime/image-router`
- [ ] C5 三协议图片请求块契约（PNG、JPEG、WEBP、GIF、远程 HTTPS）
  - 先写的测试：三个现有 `src/main/model/providers/*-adapter.test.ts`、`src/main/model/providers/sdk-stream/provider-contracts.test.ts`：PNG、JPEG、WEBP、GIF、远程 HTTPS 图 → 比较 OpenAI、Anthropic、Responses 三个协议的完整请求块、顺序、URL、鉴权方式；经 SDK 工厂取得的请求同样符合契约。该用例预期立即通过，作为回归锁定。
  - 实现：原则上只补测试；只有测试证明 `anthropic-adapter.ts::toAnthropicContent` 或 `responses-adapter.ts::toUserContentBlocks` 存在缺陷时才修改对应适配器。
  - 验证：`npm test -- src/main/agent/runtime/vendors`
- [ ] C6 不支持的 MIME、畸形 data URL、非法 URL 明确拒绝或按既有约定降级
  - 先写的测试：三个现有 `src/main/model/providers/*-adapter.test.ts`、`src/main/model/vision/image-router.test.ts`：不支持的 MIME、畸形 data URL、非法 URL → 明确拒绝或按既有约定降级；不将畸形内容作为有效图片发出。
  - 实现：在 `image-router.ts` 入口校验，适配器保持既有降级约定。
  - 验证：`npm test -- src/main/agent/runtime/vendors src/main/agent/runtime/image-router`
- [ ] C7 `vision-captioner.ts` 改为复用三协议适配器，Responses/Anthropic 不再调用 `/chat/completions`
  - 先写的测试：`src/main/model/vision/vision-captioner.test.ts`：OpenAI、Anthropic、Responses 三个协议分别执行转述 → 请求走对应协议端点并解析对应响应结构；Responses 和 Anthropic 绝不调用 `/chat/completions`。
  - 实现：修改 `src/main/model/vision/vision-captioner.ts` 使用 `getAdapterForConfig`、`buildRequest`、`parseResponse`，删除固定拼接的 `buildChatCompletionsUrl` 路径；`resolveCaptionVisionConfig` 返回的 `CaptionVisionConfig` 携带 `provider` 与 `transport`；沿用非流式调用、视觉超时和输出预算。
  - 验证：`npm test -- src/main/agent/runtime/vision-captioner`
- [ ] C8 转述 HTTP 失败、无有效内容、超时、取消返回稳定失败码
  - 先写的测试：`src/main/model/vision/vision-captioner.test.ts`：HTTP 失败、无有效内容、超时、取消 → 返回稳定失败码；无成功 caption、无成功消息写入；取消后不继续请求。
  - 实现：`vision-captioner.ts` 内部增加结构化结果；`src/main/agent/runtime/image-caption.ts::captionImageSafe` 返回错误码；保留 `captionImage` 字符串接口。
  - 验证：`npm test -- src/main/agent/runtime/vision-captioner`
- [ ] C9 模型或路由明确拒绝图片后不重复发送、不递归转述
  - 先写的测试：`src/main/agent/runtime/build-options.test.ts`、`src/main/model/vision/vision-captioner.test.ts`：模型明确拒绝图片 → 不对同一端点重复发送图片，不进行递归转述重试（端点调用次数精确为 1）。
  - 实现：修改 `src/main/agent/runtime/build-options.ts` 的回退分支，拒绝码命中时直接收口。
  - 验证：`npm test -- src/main/agent/runtime/build-options src/main/agent/runtime/vision-captioner`
- [ ] C10 `read_image`、`read_image_url` 保持现有本地路径与 URL 安全边界
  - 先写的测试：`src/main/agent/tools/fs-tools.test.ts`、`src/main/agent/tools/builtin-tools/read-image-url-tool.test.ts`：越界本地路径、被拒 URL → 保持现有边界；不读取越界内容、不发网络请求。
  - 实现：修改 `src/main/agent/tools/fs-tools.ts`、`src/main/agent/tools/builtin-tools/read-image-url-tool.ts` 改用默认档案严格选择获取视觉配置，不新增工具权限。
  - 验证：`npm test -- src/main/agent/tools/fs-tools src/main/agent/tools/builtin-tools/read-image-url-tool`
- [ ] C11 转述错误日志与 UI 不含密钥、base64 或服务回显
  - 先写的测试：`src/main/model/vision/vision-captioner.test.ts`、`src/main/agent/runtime/build-options.test.ts`：日志含模拟密钥、base64 或服务回显 → 断言日志和 UI 均不包含这些敏感值。
  - 实现：`vision-captioner.ts` 与 `image-caption.ts` 在写日志与返回 UI 前统一脱敏，只保留错误码与 `httpStatus`。
  - 验证：`npm test -- src/main/agent/runtime/vision-captioner src/main/agent/runtime/build-options`

**验收：** 18 个供应商协议组合与 3 个自定义协议判定全部通过；三协议转述均走各自正确 wire 端点；拒绝后零重复发送、零敏感信息泄露。
**回退：** 可独立 revert 组合策略调整，但不能恢复 Responses/Anthropic 被错误硬编码发送到 `/chat/completions` 的缺陷。
**工作量：** 2.5—4 人日

---

### 施工包 D：渠道完整链路及可排查失败结果

依赖：施工包 B、施工包 C
**改动文件：** `src/shared/channel-diagnostics.ts`、`src/main/features/channels/message-log.ts`、`src/main/features/channels/message-log.test.ts`、`src/main/features/channels/dispatcher.ts`、`src/main/features/channels/dispatcher.test.ts`、`src/main/features/channels/bootstrap.ts`、`src/main/features/channels/terminal-delivery.test.ts`、`src/main/features/channels/agent-policy.test.ts`、`src/main/features/channels/default-profile-flow.test.ts`、`src/renderer/settings/channels/panel.ts`、`src/renderer/settings/channels/view-model.ts`、`src/renderer/settings/channels/view-model.test.ts`、`src/renderer/settings/shared/types.ts`、`src/renderer/settings/i18n/zh-CN.json`（非测试文件 8 个）

本包落地的设计契约：

- 沿用 `LogEntry`（`src/main/features/channels/message-log.ts`）和现有日志 IPC（`channels:log:get`、`channels:log:clear`），在 `src/shared/channel-diagnostics.ts` 定义并在 `LogEntry` 增加可选 `diagnostic`：
  - `attemptId`（同一个入站请求贯穿始终使用同一 `attemptId`）
  - `stage`：`"profile" | "attachments" | "agent" | "delivery"`
  - `code`
  - `profileId`
  - `transport`
  - `httpStatus`（仅在存在时记录）
- 配置、运行和投递失败分别定位到具体 `stage`，不将“开始调用模型”记作成功回复；发送失败不追加成功 assistant 历史，也不广播成功出站镜像。
- 新增诊断字段仅允许固定字段，不写密钥、鉴权头、图片 base64、完整请求体、原始服务响应或带查询参数的 URL。`dispatcher.ts::processIncoming` 的 Agent 异常分支改为先归一化、脱敏，再写日志和控制台。

**任务：**

> 本包 D1—D7 的集成用例统一写入新增 `src/main/features/channels/default-profile-flow.test.ts`：使用真实档案解析、bootstrap、dispatcher、日志和发送回执，网络及模型使用可预测替身，避免完全 mock 掉要验证的链路。

- [ ] D1 新建 `channel-diagnostics.ts` 并打通默认档案到发送回执的成功链路
  - 先写的测试：`src/main/features/channels/default-profile-flow.test.ts`、`src/main/features/channels/message-log.test.ts`：各渠道入站文字且默认档案有效 → 一次生成、一次发送，参数及回执正确，完整历史和日志结果符合契约；同一入站请求的日志共用一个 `attemptId`。
  - 实现：新建 `src/shared/channel-diagnostics.ts`；修改 `src/main/features/channels/message-log.ts` 在 `LogEntry` 增加可选 `diagnostic`；修改 `src/main/features/channels/bootstrap.ts` 生成 `attemptId` 并贯穿。
  - 验证：`npm test -- src/main/features/channels/default-profile-flow src/main/features/channels/message-log`
- [ ] D2 模型配置缺失定位到 `profile` 阶段，只提示一次
  - 先写的测试：`src/main/features/channels/default-profile-flow.test.ts`、`src/main/features/channels/dispatcher.test.ts`：模型配置缺失 → 定位于 `profile` 阶段失败；不调用模型；失败提示只有一次；不追加成功 assistant 历史。
  - 实现：`src/main/features/channels/bootstrap.ts` 将 `MODEL_PROFILE_REQUIRED` / `MODEL_PROFILE_NOT_FOUND` 映射为 `stage: "profile"` 诊断，复用现有终态回复。
  - 验证：`npm test -- src/main/features/channels/default-profile-flow src/main/features/channels/dispatcher`
- [ ] D3 模型抛错、超时、取消返回对应终态，不写成功历史
  - 先写的测试：`src/main/features/channels/terminal-delivery.test.ts`、`src/main/features/channels/dispatcher.test.ts`：模型抛错、超时、取消 → 返回对应终态（沿用 `terminalReply`）；不展示成功贴纸，不写成功历史；诊断 `stage: "agent"`。
  - 实现：`src/main/features/channels/dispatcher.ts::processIncoming` 在 Agent 异常分支写入 `agent` 阶段诊断，不重复实现失败回复。
  - 验证：`npm test -- src/main/features/channels/terminal-delivery src/main/features/channels/dispatcher`
- [ ] D4 发送回执失败记录 `delivery` 阶段及同一 `attemptId`，不广播成功出站
  - 先写的测试：`src/main/features/channels/default-profile-flow.test.ts`、`src/main/features/channels/dispatcher.test.ts`：发送回执失败 → 记录 `delivery` 阶段失败及同一 `attemptId`；不广播成功出站镜像，不追加成功 assistant 历史。
  - 实现：`dispatcher.ts` 发送失败分支写 `delivery` 诊断，成功镜像广播移到回执成功之后。
  - 验证：`npm test -- src/main/features/channels/default-profile-flow src/main/features/channels/dispatcher`
- [ ] D5 异常先归一化、脱敏再写日志与控制台
  - 先写的测试：`src/main/features/channels/dispatcher.test.ts`、`src/main/features/channels/message-log.test.ts`：错误消息包含模拟密钥、URL 查询参数 → 日志、控制台和 UI 不出现敏感值；`diagnostic` 只含固定字段。
  - 实现：`dispatcher.ts::processIncoming` 不再直接记录 `Error.message`，改为归一化为稳定 `code` 与可选 `httpStatus` 后写入。
  - 验证：`npm test -- src/main/features/channels/dispatcher src/main/features/channels/message-log`
- [ ] D6 QQ、QQ Bot 群聊开启渠道工具时仍强制 Chat 且工具为空
  - 先写的测试：`src/main/features/channels/agent-policy.test.ts`、`src/main/features/channels/default-profile-flow.test.ts`：QQ、QQ Bot 群聊且开启渠道工具 → 仍强制为 Chat、工具为空、不调用命令或工作区写入；私聊开启 Work 时只暴露 `fs-read` 风险工具（1.2.0 规格 §7.4）。该用例预期立即通过，作为回归锁定。
  - 实现：仅补测试；只有测试证明 `features/channels/agent-policy.ts:12` 与 §7.4 不一致时才修改（需同步 SDK 计划，不在本包扩权）。
  - 验证：`npm test -- src/main/features/channels/agent-policy src/main/features/channels/default-profile-flow`
- [ ] D7 日志写盘失败时按实际发送结果结算
  - 先写的测试：`src/main/features/channels/message-log.test.ts`、`src/main/features/channels/default-profile-flow.test.ts`：日志写盘失败 → 消息链路按实际发送结果结算，不误记为生成成功或重复发送（发送次数精确为 1）。
  - 实现：`message-log.ts` 写盘异常只上报，不向调用方抛出影响发送流程。
  - 验证：`npm test -- src/main/channels`
- [ ] D8 在设置页渠道面板展示诊断编号、阶段和中文失败原因（依据原设计 3.5）
  - 先写的测试：`src/renderer/settings/channels/view-model.test.ts`：输入带 `diagnostic` 的 `LogEntry` 与旧版无 `diagnostic` 的日志行 → 完整输出包含 `attemptId`、阶段中文名和稳定错误码对应文案的视图模型，且兼容旧日志行。
  - 实现：修改 `src/renderer/settings/shared/types.ts`、`src/renderer/settings/channels/view-model.ts`、`src/renderer/settings/channels/panel.ts`、`src/renderer/settings/i18n/zh-CN.json`。
  - 验证：`npm test -- src/renderer/settings/channels`；`npm run check:renderer`

**验收：** 渠道从入站到回执全链路可追踪同一 `attemptId` 与失败阶段；异常信息脱敏无泄露；设置页清晰展示诊断阶段与原因。
**回退：** revert 本包提交；`LogEntry.diagnostic` 为可选字段，回退后旧日志读取不受影响。
**工作量：** 1.5—2 人日

---

### 施工包 E：主动聊天阶段诊断和内部受控入口

依赖：施工包 A、施工包 B
**改动文件：** `src/shared/proactive-diagnostics.ts`、`src/main/features/proactive/proactive-diagnostics.ts`、`src/main/features/proactive/proactive-diagnostics.test.ts`、`src/main/features/proactive/proactive-diagnostics-ipc.ts`、`src/main/features/proactive/proactive-diagnostics-ipc.test.ts`、`src/main/features/proactive/proactive-trigger.ts`、`src/main/features/proactive/proactive-trigger.test.ts`、`src/main/features/proactive/proactive-service.ts`、`src/main/features/proactive/proactive-service.test.ts`、`src/main/features/proactive/proactive-lifecycle.ts`、`src/main/features/proactive/proactive-lifecycle.test.ts`、`src/main/features/proactive/proactive-shutdown-delivery.test.ts`、`src/main/app/default-dependencies.ts`、`src/main/app/ipc-contract.test.ts`、`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/renderer/settings/shared/types.ts`、`src/renderer/settings/settings.ts`、`src/renderer/settings/index.html`、`src/renderer/settings/i18n/zh-CN.json`（非测试文件 13 个）

本包落地的设计契约：

- 新增 `src/shared/proactive-diagnostics.ts`，定义 `ProactiveDiagnosticResult`、`ProactiveDiagnosticStage` 及控制错误码：
  - 阶段固定为：`candidate → policy → model → delivery → persistence → notification`
  - 每阶段状态明确为：`passed`、`blocked`、`silent`、`failed`、`cancelled` 或 `not_run`（如远端渠道投递不执行本地落库，写明 `not_run`）。
  - 结果包含 `attemptId`、开始结束时间、场景、阶段有序列表、最终状态，以及成功落库后的 `sessionId`、`messageId`；不包含提示词、记忆正文和模型原始回复。
- 新增内部受控 IPC `proactive:diagnose` 与 `proactive:diagnostics:get`（`proactive-diagnostics-ipc.ts`）：
  - 默认仅 `development`、`test`、`smoke` 运行档案可调用；`production` 返回 `PROACTIVE_DIAGNOSTICS_DISABLED`（校验实际发送窗口、请求结构和运行档案，不只隐藏按钮）。
  - `preview`：只采集和计算，不调用模型、不投递、不改变状态或触发器边沿。
  - `run`：复用真实 `evaluateNow` 和服务链路，不绕过开关、busy、冷却、未回复上限、epoch 或投递检查；与定时扫描共享并发保护，禁止并行重复生成。
- 阶段摘要接入现有文件 sink（`src/main/features/proactive/proactive-diagnostics.ts`），在默认 `warn` 日志级别下也能落盘，保留最近 100 次诊断摘要；写盘失败不改变消息提交结果，界面提示“诊断记录未写入”。
- 诊断摘要上限 100 条；成功摘要也必须在默认日志级别下落盘，不通过提高全局日志级别实现。
- 内部设置页显示“检查主动聊天”（`preview`）与“执行一次真实检查”（`run`）两个按钮，后者说明会使用模型且可能发送消息；没有候选、被策略拦截、模型沉默均为可解释结果，不统一显示为错误。
- 策略、冷却、评分、天气场景和返回事件检测均保持当前行为。

**任务：**

- [ ] E1 新建 `proactive-diagnostics` 契约，`preview` 只采集计算、零副作用
  - 先写的测试：`src/main/features/proactive/proactive-diagnostics.test.ts`、`src/main/features/proactive/proactive-trigger.test.ts`：`preview` 模式 → 返回完整候选及策略结果；模型调用、投递、状态保存和触发边沿更新次数均为 0。
  - 实现：新建 `src/shared/proactive-diagnostics.ts`（`ProactiveDiagnosticResult`、`ProactiveDiagnosticStage`、错误码）与 `src/main/features/proactive/proactive-diagnostics.ts`；修改 `src/main/features/proactive/proactive-trigger.ts` 让 `evaluateNow` 支持 `preview` 并返回阶段化结果而非 `Promise<void>`。
  - 验证：`npm test -- src/main/features/proactive/proactive-diagnostics src/main/features/proactive/proactive-trigger`
- [ ] E2 没有候选时 `candidate` 阶段结束，后续全部 `not_run`
  - 先写的测试：`src/main/features/proactive/proactive-diagnostics.test.ts`、`src/main/features/proactive/proactive-service.test.ts`：没有候选 → `candidate` 阶段明确结束，后续阶段全部为 `not_run`（完整阶段数组比较）。
  - 实现：`src/main/features/proactive/proactive-service.ts` 将 `candidate_blocked` 事件映射为阶段结果。
  - 验证：`npm test -- src/main/features/proactive/proactive-diagnostics src/main/features/proactive/proactive-service`
- [ ] E3 开关、锁屏、忙、退避、冷却、未回复上限精确报告拦截原因
  - 先写的测试：`src/main/features/proactive/proactive-service.test.ts`、`src/main/features/proactive/proactive-trigger.test.ts`：开关关闭、屏幕锁定、普通会话忙、退避、冷却、未回复上限 → 精确断言 `policy` 阶段拦截原因；不调用模型或投递。
  - 实现：`proactive-service.ts` 在策略拦截处写入 `blocked` 状态与原因码，不改变策略本身。
  - 验证：`npm test -- src/main/features/proactive/proactive-service src/main/features/proactive/proactive-trigger`
- [ ] E4 模型选择沉默记为 `silent`，不写消息、不发送、不提醒
  - 先写的测试：`src/main/features/proactive/proactive-service.test.ts`：模型选择沉默 → 状态为 `silent`，不写消息、不发送、不提醒；仅保留当前已有沉默状态更新契约。
  - 实现：`proactive-service.ts` 将 `model_silent` 映射为 `model` 阶段 `silent`。
  - 验证：`npm test -- src/main/features/proactive/proactive-service`
- [ ] E5 模型失败、输出无效、超时阶段准确，不启用已下线预设文案
  - 先写的测试：`src/main/features/proactive/proactive-service.test.ts`、`src/main/features/proactive/proactive-lifecycle.test.ts`：模型失败、输出无效、超时 → `model` 阶段 `failed`；不启用已下线的预设文案，不伪装提交成功。
  - 实现：`proactive-service.ts`、`proactive-lifecycle.ts` 的失败分支写入阶段结果。
  - 验证：`npm test -- src/main/features/proactive/proactive-service src/main/features/proactive/proactive-lifecycle`
- [ ] E6 生成后发生用户活动、锁屏或关闭时 epoch／取消保护生效
  - 先写的测试：`src/main/features/proactive/proactive-lifecycle.test.ts`、`src/main/features/proactive/proactive-shutdown-delivery.test.ts`：用户活动、锁屏或关闭发生在生成后 → epoch／取消保护生效，不进入后续投递；阶段记为 `cancelled`（对应 `commit_cancelled`）。
  - 实现：`proactive-lifecycle.ts` 在 `commit_blocked` / `commit_cancelled` 处写入阶段结果。
  - 验证：`npm test -- src/main/features/proactive/proactive-lifecycle src/main/features/proactive/proactive-shutdown-delivery`
- [ ] E7 定时扫描与真实检查 `run` 共享并发保护
  - 先写的测试：`src/main/features/proactive/proactive-trigger.test.ts`：定时扫描与真实检查 `run` 并发 → 仅一个执行生成，另一个返回 busy，不重复发送。
  - 实现：`proactive-trigger.ts` 让 `run` 复用 `evaluateNow` 的同一并发锁，不绕过开关、busy、冷却、未回复上限、epoch 或投递检查。
  - 验证：`npm test -- src/main/features/proactive/proactive-trigger`
- [ ] E8 production 或未授权发送方调用诊断 IPC 返回 `PROACTIVE_DIAGNOSTICS_DISABLED`
  - 先写的测试：`src/main/features/proactive/proactive-diagnostics-ipc.test.ts`、`src/main/app/ipc-contract.test.ts`：production 运行档案或未授权发送窗口调用 `proactive:diagnose` / `proactive:diagnostics:get` → 返回稳定拒绝码 `PROACTIVE_DIAGNOSTICS_DISABLED`；不采集诊断、不访问模型、不写消息；非 production 授权窗口调用 → 正常返回阶段结果。
  - 实现：新建 `src/main/features/proactive/proactive-diagnostics-ipc.ts`（校验实际发送窗口、请求结构和运行档案）；修改 `src/main/app/default-dependencies.ts`、`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/renderer/settings/shared/types.ts`、`src/renderer/settings/settings.ts`、`src/renderer/settings/index.html`、`src/renderer/settings/i18n/zh-CN.json`（两个内部按钮及说明文案）。
  - 验证：`npm test -- src/main/features/proactive/proactive-diagnostics-ipc src/main/app/ipc-contract src/main/app/default-dependencies`；`npm run build:main`；`npm run build:preload`；`npm run check:renderer`
- [ ] E9 十二小时、两小时、评分 75 等既有临界点两侧结论不变
  - 先写的测试：`src/main/features/proactive/proactive-trigger.test.ts`、`src/main/features/proactive/proactive-service.test.ts`（假定时器并在 `afterEach` 恢复）：十二小时、两小时、评分 75、两次未回复等既有临界点两侧 → 保留当前测试结论，不改变策略（`proactive-policy.ts:9,10,12,48`）。该用例预期立即通过，作为回归锁定。
  - 实现：无；本任务只锁定回归。
  - 验证：`npm test -- src/main/proactive`
- [ ] E10 默认日志级别下摘要落盘、重载可查、超出 100 条只保留最近记录
  - 先写的测试：`src/main/features/proactive/proactive-diagnostics.test.ts`：默认日志级别下产生摘要 → 独立临时目录文件中可读到完整安全摘要（不含提示词、记忆正文、模型原始回复），重载后可查询，超出 100 条只保留最近 100 条；写盘失败时附带“诊断记录未写入”标记且不回滚已提交消息。
  - 实现：`src/main/features/proactive/proactive-diagnostics.ts` 接入 `base/logging/logger.ts` 现有文件 sink，不提高全局级别。
  - 验证：`npm test -- src/main/proactive`

**验收：** 主动聊天六阶段状态在文件摘要与内部诊断界面中完整可查；`preview` 零副作用；`production` 严格拒绝诊断 IPC 调用；并发保护与既有冷却策略零回归。
**回退：** revert 本包提交；关闭诊断功能不影响主动聊天消息服务本身。
**工作量：** 2—3 人日

---

### 施工包 F：主动消息提醒与三窗口状态可见性

依赖：施工包 E
**改动文件：** `src/shared/toast-types.ts`、`src/main/platform/interaction/toast-events.ts`、`src/main/platform/interaction/toast-events.test.ts`、`src/main/platform/toast/toast-service.ts`、`src/main/platform/toast/toast-service.test.ts`、`src/main/features/proactive/proactive-lifecycle.ts`、`src/main/features/proactive/proactive-lifecycle.test.ts`、`src/main/app/default-dependencies.ts`、`src/main/app/default-dependencies.test.ts`、`src/renderer/react/features/chat/pages/ChatPage.tsx`、`src/renderer/react/features/chat/pages/proactive-visibility.test.ts`、`src/renderer/toast/toast.ts`、`src/renderer/toast/toast.test.ts`、`src/renderer/react/i18n/zh-CN.json`（非测试文件 8 个）

本包落地的设计契约：

- 扩展现有 Toast：
  - 新增 `ToastKind: "proactive-message"`（`src/shared/toast-types.ts`）。
  - 新增 `ProactiveMessageCommittedEvent`（`src/main/platform/interaction/toast-events.ts`），只携带 `sessionId`、`messageId`、时间，仅在本地消息成功落库后由 `proactive-lifecycle.ts` 发布。
  - `messageId` 作为去重业务 ID，目标为已有 `ToastTarget` 的指定会话。
  - 默认文案“流萤发来了一条主动消息”，不展示私密正文；音效沿用现有开关；点击后通过现有窗口激活代理打开专用 Chat 会话。
- 三种窗口/会话状态表现：
  | 状态 | 表现 |
  |---|---|
  | 聊天窗口关闭或隐藏 | 显示 Toast；用户点击后打开主动会话 |
  | 正在查看其他会话，包括 Work、Code | 显示 Toast，不自动切换当前会话 |
  | 正在查看主动会话且窗口聚焦 | 刷新消息列表并显示新消息，抑制重复 Toast |
- 提醒失败单独记录到诊断 `notification` 阶段，不能撤销已成功保存的消息，也不能触发重新生成或重新发送。

**任务：**

- [ ] F1 新增 `ToastKind: "proactive-message"` 与 `ProactiveMessageCommittedEvent`，仅在本地落库成功后发布一次
  - 先写的测试：`src/main/features/proactive/proactive-lifecycle.test.ts`、`src/main/platform/interaction/toast-events.test.ts`：本地落库成功 → 发布一次带确切 `messageId` 的 `ProactiveMessageCommittedEvent`（只含 `sessionId`、`messageId`、时间）；会话广播与 Toast 提醒引用同一 `sessionId`。
  - 实现：修改 `src/shared/toast-types.ts`、`src/main/platform/interaction/toast-events.ts`；在 `src/main/features/proactive/proactive-lifecycle.ts:183`—`:199` 落库与广播之后发布事件。
  - 验证：`npm test -- src/main/features/proactive/proactive-lifecycle src/main/platform/toast/toast-events`
- [ ] F2 落库失败或提交已取消不发布 Toast
  - 先写的测试：`src/main/features/proactive/proactive-lifecycle.test.ts`：落库失败或提交已取消 → 不发布 Toast，不标记完整提交。
  - 实现：`proactive-lifecycle.ts` 发布点只放在落库成功分支。
  - 验证：`npm test -- src/main/features/proactive/proactive-lifecycle`
- [ ] F3 同一 `messageId` 重复到达只展示一次、不重复播放提示音
  - 先写的测试：`src/main/platform/toast/toast-service.test.ts`：同一 `messageId` 事件重复到达 → 只展示一次，不重复播放提示音。
  - 实现：`src/main/platform/toast/toast-service.ts` 以 `messageId` 作为去重业务 ID，复用现有去重与音效合并。
  - 验证：`npm test -- src/main/platform/toast/toast-service`
- [ ] F4 聊天窗口关闭或隐藏时点击 Toast 打开指定主动会话
  - 先写的测试：`src/main/platform/toast/toast-service.test.ts`、`src/main/app/default-dependencies.test.ts`、`src/renderer/toast/toast.test.ts`：关闭窗口 → 显示 Toast，点击后请求打开指定主动会话（`ToastTarget` 指向专用 Chat 会话），默认文案为“流萤发来了一条主动消息”且不含正文。
  - 实现：`toast-service.ts` 构造目标；`src/main/app/default-dependencies.ts` 接线现有窗口激活代理；`src/renderer/toast/toast.ts` 渲染新类型；`src/renderer/react/i18n/zh-CN.json` 补文案。
  - 验证：`npm test -- src/main/toast src/main/app/default-dependencies.test.ts src/renderer/toast`
- [ ] F5 正在查看其他 Chat／Work／Code 会话时显示提醒但不切换、不动草稿
  - 先写的测试：`src/renderer/react/features/chat/pages/proactive-visibility.test.ts`：当前为另一 Chat／Work／Code 会话时主动消息落库 → 显示提醒，当前会话、运行视图和输入草稿保持不变；只有用户点击提醒后才切换到主动会话。
  - 实现：修改 `src/renderer/react/features/chat/pages/ChatPage.tsx`（`:337` 的 `store.onChanged(refresh)`）只刷新列表，不切换当前会话。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/proactive-visibility.test.ts`；`npm run check:renderer`
- [ ] F6 当前主动会话聚焦时刷新可见并抑制 Toast
  - 先写的测试：`src/renderer/react/features/chat/pages/proactive-visibility.test.ts`、`src/main/platform/toast/toast-service.test.ts`：当前正在查看主动会话且窗口聚焦 → 收到变更广播后立即刷新，新主动消息实际可见；`toast-service` 抑制重复 Toast。
  - 实现：`ChatPage.tsx` 对主动会话做焦点/会话感知刷新；`toast-service.ts` 读取焦点会话状态决定是否抑制。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/proactive-visibility.test.ts src/main/platform/toast/toast-service`
- [ ] F7 Toast 创建失败只记 `notification` 阶段失败，不重生成、不重投递
  - 先写的测试：`src/main/features/proactive/proactive-lifecycle.test.ts`、`src/main/platform/toast/toast-service.test.ts`：Toast 创建或展示抛错 → 消息仍只保存一次，诊断 `notification` 阶段记为 `failed`；不重新生成或重复投递。
  - 实现：`proactive-lifecycle.ts` 捕获提醒异常并写入阶段结果，与 `persistence` 分开记录。
  - 验证：`npm test -- src/main/features/proactive/proactive-lifecycle src/main/platform/toast/toast-service`
- [ ] F8 用户关闭 Toast、超时、应用退出时正确清理
  - 先写的测试：`src/main/platform/toast/toast-service.test.ts`、`src/renderer/toast/toast.test.ts`（假定时器）：用户关闭 Toast、超时、应用退出 → 正确清理计时器和订阅，不删除会话消息。
  - 实现：`toast-service.ts` 与 `src/renderer/toast/toast.ts` 在三种结束路径统一释放计时器与订阅。
  - 验证：`npm test -- src/main/toast src/renderer/toast`

**验收：** 关闭窗口、停留其他会话、停留当前主动会话三种状态下主动消息可见性与提醒抑制完全符合设计表；提醒失败不引起重发或回滚落库。
**回退：** revert 本包提交；可独立关闭主动消息 Toast 事件订阅，保留主动消息落库。
**工作量：** 1.5—2.5 人日

---

### 施工包 G：三份渠道接入指南、契约核对与发布验收记录

依赖：施工包 C、施工包 D（若文档与工程计划施工包 B 已创建指南文件，则在此核对合并图片/诊断说明与矩阵真机记录）
**改动文件：** `docs/user-guide/feishu.md`、`docs/user-guide/napcat-onebot.md`、`docs/user-guide/qqbot-official.md`、`README.md`、`docs/qa/1.2.0-image-channel-matrix.md`；仅在指南核对揭示未覆盖的当前契约时补充飞书、NapCat、QQ Bot 现有测试文件（非测试文件 5 个）

本包落地的指南要求：

- 三份指南统一包括前提、全新 1.2.0 配置入口、权限、连接检查、首条文字消息、媒体测试、访问控制、模式限制（含三档权限与渠道只放行 `fs-read` 的说明）、诊断日志排障、停用和清理方法。
- 飞书包含发送者白名单、陌生发送者批准流程，群消息当前忽略（仅处理 `p2p`；默认关闭任意私聊放行，不能写成“没有白名单”）。
- NapCat 明确连接方向、运行时 URL、默认端口、Token、白名单及可配置的 @ 条件；媒体参数取自 `onebot-media.ts` 常量。
- 官方 QQ 机器人区分 openid 与 QQ 号，说明仅被动回复、出站仅文本、长回复可能受到条数限制。
- 不写“零封号风险”“所有网络均可连接”等无法保证的结论；平台权限、下载包名称和平台配额附官方链接与核对日期，未核实内容不能写成固定事实。
- 所有指南从全新 1.2.0 配置开始，不指导复制旧目录。

**任务：**

- [ ] G1 飞书未批准发送者不下载媒体、不进入 Agent
  - 先写的测试：复用并按需补充 `src/main/features/channels/adapters/feishu/` 下发送者测试：飞书未批准发送者 → 不下载媒体、不进入 Agent（`admitSender` 先于媒体下载）。该用例预期立即通过，作为回归锁定。
  - 实现：只补缺失的边界测试断言，不改动已符合要求的适配器实现。
  - 验证：`npm test -- src/main/features/channels/adapters/feishu`
- [ ] G2 NapCat 群要求 @ 开启／关闭时分别拒绝／允许非 @ 消息，白名单始终有效
  - 先写的测试：复用并按需补充 `src/main/features/channels/adapters/qq/` 下 `isQqEventAllowed` 测试：群要求 @ 开启／关闭 → 分别验证非 @ 消息拒绝／允许；白名单始终有效。该用例预期立即通过，作为回归锁定。
  - 实现：只补测试断言。
  - 验证：`npm test -- src/main/features/channels/adapters/qq`
- [ ] G3 NapCat 非回环监听缺 Token 拒绝启动，Token 错误握手不进入消息处理
  - 先写的测试：复用并按需补充 `onebot-reverse-ws` 相关测试：非回环监听缺 Token → 拒绝启动；Token 错误握手不进入消息处理。该用例预期立即通过，作为回归锁定。
  - 实现：只补测试断言。
  - 验证：`npm test -- src/main/features/channels/adapters/qq`
- [ ] G4 QQ Bot 不在 openid 白名单不回复，超窗及超次数不调用发送 API
  - 先写的测试：复用并按需补充 `src/main/features/channels/adapters/qqbot/` 被动回复测试：不在 openid 白名单 → 不生成回复；超窗（`REPLY_WINDOW_MS`）及超次数（`REPLY_SEQ_LIMIT`）不调用发送 API。该用例预期立即通过，作为回归锁定。
  - 实现：只补测试断言。
  - 验证：`npm test -- src/main/features/channels/adapters/qqbot`
- [ ] G5 媒体大小、分片、缓存时间边界取当前常量在临界点及两侧断言
  - 先写的测试：NapCat 媒体（`onebot-media.ts` 常量）与 QQ Bot 入站 8 MiB 限制（`qqbot-adapter.ts:223`）：媒体大小、分片、缓存时间边界 → 取当前常量，在临界点及两侧断言。该用例预期立即通过，作为回归锁定。
  - 实现：只补测试断言；不调整常量。
  - 验证：`npm test -- src/main/channels`
- [ ] G6 编写/完善三份渠道用户指南并更新 `README.md` 与 `docs/qa/1.2.0-image-channel-matrix.md` 真实服务验证记录
  - 先写的测试：G1—G5（不为纯文档增加静态字符串匹配测试框架；指南路径、按钮、默认值和模式限制逐项与源码核对，不用测试静态字符串替代真实接入验收）。
  - 实现：完成 `docs/user-guide/feishu.md`、`docs/user-guide/napcat-onebot.md`、`docs/user-guide/qqbot-official.md`（按上列指南要求）；在 `README.md` 渠道说明中链接指南；在 `docs/qa/1.2.0-image-channel-matrix.md` 补齐真实渠道、窗口状态和打包版验证证据。
  - 验证：`git diff --check`；对照源码逐项核对指南中的路径、按钮文案、默认值和模式限制

**验收：** 三份指南与适配器源码及 1.2.0 渠道诊断界面完全一致；`1.2.0-image-channel-matrix.md` 完整记录已验证组合与未验证组合。
**回退：** revert 文档提交，保留补齐的渠道边界测试。
**工作量：** 1—1.5 人日

## 验收清单（全量）

命令来自 `package.json:156` 起及现有测试入口。

- [ ] 施工包 A–G 全部合并，各包最近测试通过：
  ```powershell
  # 施工包 A
  npm test -- src/main/startup
  node --test scripts/dev/launch-electron.test.mjs

  # 施工包 B
  npm test -- src/main/platform/settings/model-settings src/main/features/sessions/chat-ui-ipc src/main/agent/runtime/agent-runtime src/main/agent/runtime/build-options src/main/features/channels/bootstrap src/renderer/react/features/chat/hooks/useComposerAttachments

  # 施工包 C
  npm test -- src/main/agent/runtime/image-router src/main/agent/runtime/vision-captioner src/main/agent/runtime/vendors src/main/agent/tools/fs-tools src/main/agent/tools/builtin-tools/read-image-url-tool src/main/agent/runtime/build-options

  # 施工包 D & G
  npm test -- src/main/channels src/renderer/settings/channels

  # 施工包 E
  npm test -- src/main/proactive src/main/app/ipc-contract src/main/app/default-dependencies

  # 施工包 F
  npm test -- src/main/toast src/main/proactive src/renderer/toast src/renderer/react/features/chat/pages
  ```
- [ ] 类型、存储边界、构建与全量集成检查通过（`npm test` 覆盖现有 Vitest 配置集合，启动器 `.test.mjs` 单列）：
  ```powershell
  npm run check:storage-boundary
  npm run build:main
  npm run build:preload
  npm run check:renderer
  npm run build:renderer
  npm test
  npm run build
  git diff --check
  git status --short
  ```
- [ ] 真机与打包验证（1.5—2 人日，施工时记录执行提交、退出码、测试归档路径、跳过原因及未验证项）：
  1. **先确认施工包 A 已完成**：创建全新隔离目录，使用当前启动器支持的 `FIREFLY_ISOLATION_ROOT` 启动 `npm run dev`，不使用旧配置和凭据文件；打包验证使用 `npm run package:win:dir`，以 smoke 档案及全新隔离根启动生成的程序。
  2. **三模式图片**：分别在 Chat、Work、Code 中测试附件、粘贴和截图；分别设置默认档案、绑定另一档案、切换协议，核对实际请求和诊断。真服务只测试矩阵中有凭据的组合，其余在 `docs/qa/1.2.0-image-channel-matrix.md` 标记未验证。
  3. **渠道**：按三份指南从空配置接入，依次验证拒绝发送者、允许发送者、文字、图片及适用媒体、断线重连、模型失败和发送失败。
  4. **主动聊天**：内部真实检查按当前策略运行；无候选或被拦截应展示原因。使用隔离测试配置构造可投递场景，核对生成、落库、状态文件和摘要一致。
  5. **三个窗口状态**：关闭窗口、停留其他会话、停留主动会话；逐一核对可见消息、提醒、点击目标和不抢占行为。Work、Code 还需确认草稿及运行视图保留。
  6. **打包日志**：不依赖开发者控制台，从新数据目录读取主动诊断和渠道日志；记录“已落库但提醒失败”等部分结果。
  7. **数据隔离**：确认本次进程实际 `userData`、session、日志均位于新根 `%APPDATA%\Firefly-1.2.0`（或测试隔离根）；不打开真实旧目录采样验证。

## 回滚方案

| 风险 | 控制和回退 |
|---|---|
| 端点能力资料滞后 | 区分已确认与未确认；保留用户明确声明的试发选择；修正矩阵规则不需要改变协议适配器 |
| 未确认组合默认拒绝影响现有可用模型 | 已由负责人确认为“用户明确声明图片时允许试发，仅目录推断时要求确认”，逐项记录受影响组合，不静默扩大限制 |
| 档案选择修正改变原有请求目标 | 入口测试覆盖优先级及快照；出错时明确失败，不自动改用另一份凭据 |
| 三协议转述扩大调用面 | 复用现有适配器，保持单次调用、超时和取消；可独立回退转述改动，但不能恢复 Responses 被错误发送到 Chat Completions 的行为 |
| 新诊断泄露内容或增长过快 | 固定字段、无正文摘要、最多 100 次；关闭诊断功能不影响消息服务 |
| 主动提醒重复或抢焦点 | 消息 ID 去重；只有点击才激活；可独立关闭事件订阅，保留落库 |
| 提醒失败被误认作投递失败 | 分开记录 `persistence` 与 `notification`；禁止重新生成或重复发送 |
| 平台限制或权限变化 | 发布前核对官方资料，更新指南和受影响契约测试 |
| 数据目录回退导致旧数据被读取 | 1.2.0 的回退版本仍使用新根；禁止通过把路径改回旧根实现回退 |

每个施工包独立回退代码；不删除用户新数据，不执行自动降级迁移。渠道适配器、模型失败和消息发送的外部效果不会因代码回退自动撤销。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

已采纳并写入对应施工包的结论：
- 1.2.0 新数据目录名称及归属：使用 `%APPDATA%\Firefly-1.2.0`；由版本基础主题统一交付，本主题以其为运行前置条件（施工包 A）。
- 未确认图片端点组合的默认行为：用户明确声明图片时允许试发；只有目录推断时要求确认（`IMAGE_TRANSPORT_UNVERIFIED`），避免错误宣称端点已支持（施工包 C）。
- 是否将转述补齐三个协议：补齐，复用现有 OpenAI、Anthropic、Responses 适配器；不恢复独立视觉模型配置（施工包 C）。
- 明确指定的档案被删除时如何处理：明确失败（`MODEL_PROFILE_NOT_FOUND`），不自动选择另一供应商；缺省选择仍用默认档案（施工包 B）。
- 内部真实检查是否允许绕过策略：不允许；用隔离测试场景构造可投递条件，生产逻辑保持一致（施工包 E）。
- production 是否提供真实主动聊天测试按钮：1.2.0 暂不提供（返回 `PROACTIVE_DIAGNOSTICS_DISABLED`）；内部档案提供，正式版保留安全诊断记录（施工包 E）。
- 主动消息提醒及预览内容：启用现有 Toast（`ToastKind: "proactive-message"`），仅显示通用提示“流萤发来了一条主动消息”；不默认展示消息正文，不自动抢焦点（施工包 F）。
- QQ 群、渠道 Code 和主动投递目标是否扩展：本主题不扩展；保持现有模式、权限和主动投递目标（施工包 D/G）。
- 真服务验收资源不足时是否发布：明确列出未验证组合；已宣称支持的主要组合及三个渠道至少完成一次真实验收，不能以 mock 测试代替（施工包 C/G）。

仍真正未决的项：无。

## 工作量

按一名熟悉仓库的工程师估算，包含实现、相邻测试及修正，不含等待平台审核或凭据：

| 施工包 | 估计 |
|---|---:|
| 施工包 A：新数据根及启动验收 | 1—1.5 人日（若已有交付，仅需约 0.25 人日核对） |
| 施工包 B：档案选择及请求快照一致性 | 1.5—2 人日 |
| 施工包 C：组合矩阵、三协议转述及回归 | 2.5—4 人日 |
| 施工包 D：渠道完整链路及诊断 | 1.5—2 人日 |
| 施工包 E：主动聊天阶段诊断及内部入口 | 2—3 人日 |
| 施工包 F：主动消息提醒和窗口可见性 | 1.5—2.5 人日 |
| 施工包 G：三份指南及真实接入核对 | 1—1.5 人日 |
| 最终集成、打包验证与问题修正 | 1.5—2 人日 |
| **合计** | **约 13—18.5 人日** |
