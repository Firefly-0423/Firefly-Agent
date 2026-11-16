状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 图片输入与投递边界

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
区分模型可接收图片、实际图片发送和文字转述，让拒绝或降级可解释。本文合并原图片链路核查，工具直接返回图片仍是独立设计目标。

## 当前实现
| 能力 | 代码依据 |
|---|---|
| 档案和能力 | `src/main/model/config/model-settings.ts` 解析档案，`src/main/model/providers/multimodal.ts` 的 `resolveInputModalities` 按声明与目录确定能力，未知按文本。 |
| 路由 | `src/main/model/vision/image-router.ts` 的 `ImageRoute` 仅含 direct/reject，`resolveImageRoute` 要求 multimodal 明确为 true。 |
| 附件 | `src/main/agent/runtime/build-options.ts` 构建图片消息；`src/main/agent/runtime/image-caption.ts` 的 `captionImageSafe` 包装本地转述。 |
| 转述 | `resolveCaptionVisionConfig` 复用当前模型配置，但明确拒绝 explicitTransport 为 anthropic；`src/main/model/vision/vision-captioner.ts` 返回文字描述。 |
| 工具 | `src/main/agent/tools/fs-tools.ts` 与 `src/main/agent/tools/builtin-tools/read-image-url-tool.ts` 返回转述文字；`src/main/model/providers/types.ts` 的 `ToolExecutionResult.output` 是字符串。 |
| 桌面与渠道 | `src/main/features/sessions/chat-ui-ipc.ts`、`src/main/features/channels/bootstrap.ts` 接入路由，保留各自授权和会话归属。 |

## 行为与失败边界
direct 是能力判断，不证明发送或理解成功。转述不是主模型收到原图；URL 图片由服务侧取图也不证明其可访问。当前入口格式集合不完全相同，本地工具允许的格式不保证每个协议接受。

拒绝和转述失败主要通过模型上下文表达，不能保证用户界面一定独立展示原因。文件验证、转述回调缺失和异常分支需结合入口核对；正常链路已有回调检查，不能仅凭一处分支推断桌面必现丢图。

## 未完成与施工入口
统一格式拒绝、逐图失败反馈和独立界面提示，由[提醒与界面计划](../superpowers/plans/2026-11-12-reminders-and-ui.md)及[进度](../superpowers/plans/2026-11-12-reminders-and-ui-progress.md)承接。首版拒绝不支持格式，不自动转码，不改变工具结果为图片块；请求失败重试另见[模型错误分类计划](../superpowers/plans/2026-11-12-model-error-classification.md)。

可选工具图片结果尚未批准：先试点本地图片读取，使用 Main 发放且绑定会话/run/调用的受控引用，发送前复核来源、文件身份、格式、容量和取消；协议投影保持工具配对，日志不含图片字节。不支持时明确失败，是否提供显式转述选择待定。短期或持久引用、保留与删除、协议支持范围未定，不预写不存在的类型和路径。

现有测试入口：`src/main/model/vision/image-router.test.ts`、`src/main/agent/runtime/image-caption.test.ts`、`src/main/agent/runtime/build-options.test.ts`。本次未执行真实协议请求、格式矩阵或界面验收。
