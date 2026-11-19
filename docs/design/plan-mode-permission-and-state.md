状态：设计提案（现状整理）
实现状态：部分实现

# Firefly 计划模式权限与状态恢复

日期：2026-11-12
核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
计划讨论期间限制副作用，明确计划正文、项目隐式修改和执行许可的关系；新增持久化恢复必须失败时保持保守边界。

## 当前实现
| 主题 | 文件、符号和行为 |
|---|---|
| 内存状态机 | `src/main/agent/tools/plan-mode.ts` 的 `PlanStateName`、`getPlanState`、`isPlanReadOnly`；状态为 NORMAL、PLAN_DISCUSSING、PLAN_REVIEW、EXECUTING。 |
| 权限 | `src/main/agent/runtime/adapter/tool-runtime.ts` 的 `prepareToolRuntime` 在 allow_all 前检查计划限制，审批后和执行前再复核；当前仍按 risk 判定。 |
| 计划写入 | `src/main/agent/loop/plan-tools.ts` 的 `executeWritePlan` 写计划并标记；`ensureWorkspaceMetadataIgnored` 还可能修改项目 `.gitignore`。 |
| 路径 | `buildWorkspacePlanPath` 使用工作区的 `.firefly/docs/plan-<时间>.md`；无工作区时使用已初始化数据根下 `plans/<conversationId>/plan.md`。 |
| 生命周期 | `src/main/agent/runtime/adapter/plan-lifecycle.ts` 的 `preparePlanRunContext`、`completePlanRun` 目前显式覆盖 Chat / Code。 |
| 副作用 | `src/main/agent/loop/side-effect-resolver.ts` 将 unknown 保守映射；verification 仍按 read_only 处理。 |

## 失败与现有限制
计划状态保存在 Map，没有计划状态落盘及重启 restore；运行快照恢复不等于计划状态恢复。当前计划文件读取失败记录日志，不能宣称有可靠冻结修订或故障恢复。写计划可能改忽略规则，因此不能描述为仅写一份计划文件。

计划限制已先于免审批，不重复登记为“allow_all 绕过守卫”的已复现缺陷；但 risk 策略也不等于已经落实“只允许 effect=read”。

## 未实现目标与归属
按 effect 只允许明确 read、拒绝 unknown、mutation、verification、external_side_effect 并保持 Shell 禁止，采用[提醒与界面计划](../superpowers/plans/reminders-and-ui.md)。这是目标，不写成当前代码。

以下仍是未批准提案：移除写计划时的 `.gitignore` 修改；可靠提交计划状态、修订和执行所有者；重启将 REVIEW/EXECUTING 收回讨论态，旧卡失效且零模型/工具自动调用；保存失败不发布批准，损坏状态不自动放开权限。具体后端、恢复提示消费、Work 生命周期覆盖和损坏状态处理尚未决定，不新增猜测源码路径。

verification 分类需逐工具核对真实写入和外部动作，不能因“验证”意图就统一认为可并行重试。[会话可靠性计划](../superpowers/plans/conversation-reliability.md)负责运行事实恢复，[同运行审批提案](plan-approval-in-run.md)负责审批接续，二者不能各自成为许可权威。

已有测试：`src/main/agent/tools/plan-mode.test.ts`、`src/main/agent/loop/plan-tools.test.ts`、`src/main/agent/runtime/adapter/tool-runtime.test.ts`、`src/main/agent/runtime/adapter/plan-lifecycle.test.ts`。本次未执行；持久化和重启目标尚无本次验收。
