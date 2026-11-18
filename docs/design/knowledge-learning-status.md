状态：设计提案（现状整理）
实现状态：已实现

# Firefly 知识工作区与学习闭环

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
在 Work 的既有材料目录内读材料、解释、抽查并更新已有学习进度；这是 Work 能力，没有第四种学习会话模式。

## 当前实现
| 能力 | 入口与行为 |
|---|---|
| 工作区识别 | `src/main/knowledge/workspace/knowledge-workspace.ts` 的 `openKnowledgeWorkspace` 仅接受 work，并要求根目录含 `.obsidian` 或 `learn/progress.md`，服务 ready 后才返回。 |
| 材料读取 | `src/main/knowledge/workspace/obsidian/obsidian-tools.ts` 与 `src/main/knowledge/workspace/obsidian/obsidian-workspace-service.ts` 提供列表、搜索、读取与冲突检查；关键类型为 `ObsidianWorkspaceService`。 |
| 教学约定 | `prompts/knowledge_workflow.md` 要求材料优先、按需导学并允许跳过；提示词要求不等于强制阅读证明。 |
| 抽查 | `src/main/agent/runtime/pop-quiz.ts` 的 `buildPopQuizPublication`、`gradeQuizSubmission` 与 `popQuizTool` 支持四类题，工具限 Work；公开题卡与私有答案分离。 |
| 进度 | `src/main/features/chat/agui-bridge.ts` 取本轮作答证据，调用 `src/main/knowledge/workspace/progress/learn-post-turn.ts` 的 `runLearnPostTurnHook`。 |
| 图表 | `src/renderer/react/features/chat/components/StreamdownMessageContent.tsx` 分流到 `src/renderer/react/features/chat/components/MermaidBlock.tsx`、`src/renderer/react/features/chat/components/SvgCardBlock.tsx`；流式占位，完成后渲染。 |

## 行为与失败边界
选择和判断本地判分，简答返回 pending_model 等模型讲评；非法作答不结算，首次合法作答后移除 pending。跳过不增加答题证据，取消按 runId 清理重播；未知身份返回 `E_QUIZ_NOT_FOUND`。十秒重播是进程内机制，不提供重启恢复。

进度更新先核对 fs-write 策略、工作区、教学内容和已有进度文件；后台提取失败只记录失败，不等于保存成功。仅有材料目录不保证自动识别，也不自动创建缺失进度。模型提供的 sourceRef 不是宿主读取凭证。

图表通过 `src/renderer/react/features/chat/components/svg-sanitize.ts` 限长并消毒；渲染失败回退源码，不能把提示词禁止脚本当作实际安全门禁。

## 未完成与计划
主进程阅读证据绑定、跨重启抽查恢复尚未提供；材料理解质量与图表布局需真实模型和界面验收。提醒定位和权限增量链接[提醒与界面计划](../superpowers/plans/reminders-and-ui.md)，恢复链接[会话可靠性计划](../superpowers/plans/conversation-reliability.md)。

现有测试入口：`src/main/knowledge/workspace/knowledge-workspace.test.ts`、`src/main/agent/runtime/pop-quiz.test.ts`、`src/main/knowledge/workspace/progress/learn-post-turn.test.ts`、`src/renderer/react/features/chat/components/svg-card-block.test.ts`。本次未执行。
