# 外部渠道私聊开启工具后采用 `work` 与 `allow_all` 直接执行

状态：待修复（待渠道 Work 收紧落地后由施工包 B6 跟进）
日期：2026-11-16

## 现象

在飞书、QQ（NapCat）、官方 QQ 机器人或微信等外部渠道接入中，除了 QQ 与官方 QQ 机器人群聊被强制限制为 `chat` 模式外，其余满足准入的外部渠道会话只要开启工具（`toolSandbox !== "off"`），就会进入 `work` 执行模式并直接赋予 `permissionMode: "allow_all"`；所有开放给渠道的工具会绕过桌面审批直接执行，远程用户可能触发文件读写或命令操作，与 1.2.0 规划的渠道只读收口目标不符。

## 触发条件或复现步骤

1. 在设置中配置并启用外部渠道（非 QQ / 官方 QQ Bot 群聊场景，例如私聊），并将 `toolSandbox` 设为非 `"off"`。
2. 观察 `src/main/features/channels/agent-policy.ts` 的 `resolveChannelAgentPolicy`（第 12–21 行）：
   - `groupRestricted` 仅当 `channel` 为 `"qq"` 或 `"qqbot"` 且 `chatType === "group"` 时为 `true`；
   - 当 `toolsAllowed = !groupRestricted && toolSandbox !== "off"` 为 `true` 时，直接返回 `executionMode: "work"` 与 `permissionMode: "allow_all"`（仅 `includeInteractiveTools: false`）。
3. 运行经 `enforceChannelAgentPolicy` 后不经过桌面审批卡确认即可执行可用工具。

## 影响范围

- **受影响范围**：开启了远程工具的外部渠道私聊（以及非 QQ/QQ Bot 的其他符合条件群聊）与相关用户指南 / 免责声明（`docs/disclaimer.zh-CN.md` ④、`docs/user-guide/`）。
- **已有限制**：QQ 与官方 QQ 机器人群聊已被强制限定为 `chat`；渠道不可选择 `code` 模式；交互类工具被置为 `includeInteractiveTools: false`。

## 根因

1. 当前 `resolveChannelAgentPolicy` 在代码层尚未引入 1.2.0 规格要求的“渠道默认 Chat、Work 仅放行 `fs-read`、拒绝在外部平台发起/等效审批”的收紧策略。
2. 根据 `docs/superpowers/plans/2026-11-12-docs-and-engineering.md`（全局约束）与 `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`（未完成项 B6），渠道文档当前先如实披露“开启工具后为 `work` + `allow_all`”的现状与风险，等待独立渠道收紧施工合入后再更新策略与文档。

## 当前状态

- **待修复**：
  - `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md` 未完成项 B6 与验收待办继续挂起，等待渠道 Work 收紧实现（对应 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.4 仅放行 `fs-read` 风险工具的策略）。
  - 当前 `docs/disclaimer.zh-CN.md`（④ 工具与授权风险）与 `docs/user-guide/` 已将该行为明确标注为现状与安全警示。

## 相关文件

- `src/main/features/channels/agent-policy.ts`（`resolveChannelAgentPolicy`、`enforceChannelAgentPolicy`）
- `docs/superpowers/plans/2026-11-12-docs-and-engineering-progress.md`（未完成项 B6、验收待办）
- `docs/superpowers/plans/2026-11-12-docs-and-engineering.md`（全局约束）
- `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md`（§7.4 外部渠道的模式）
- `docs/disclaimer.zh-CN.md`（第 ④ 条渠道 Work 说明）
