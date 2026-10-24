# 外部技能市场独立 PR：最新基线整合验证

代码头：`3adfbe9c19869a82c06d2f693cd09ae574668c76`；目标基线：`271f1dd5baf4a24939fdfe9c2c5d91d718cade11`。原批次、尾项及整合分支均保留，本次独立提交不含设备模拟代码，也未改 CI。

## 整合证据

上游自原整合基线以来变动 55 个文件，与本批次只重叠两份翻译 JSON。逐叶核对每份 1252 项，两侧分别变动 22 项和 3 项，均完整保留；其余 36 个批次文件与原审核头 canonical Git blob 相同。Claude manifest 版本优先级与不支持文件模式的早期阻断修复均保留。

## 实际验证

- 最新整合代码相关回归：1001 通过、0 失败、2 跳过，33 个文件，未处理异常 0。测试开始与结束均为干净的同一代码头。
- Main 类型、preload、renderer 类型、renderer 构建和存储边界检查均 exit 0。使用独立复制的既有依赖和假用户/TEMP/cache；没有新安装、候选执行或生命周期脚本。
- 历史全量为旧整合代码 `2d2d35b9c44ced39fbfee02fbc86aceaa3138e9c` 上 10755 通过、11 跳过、未处理异常 0；不能视为当前最新基线的全量结果。新 PR 的既有远端 CI 另行记录。

## 支持范围与边界

仅允许 openai/plugins、anthropics/skills 两个固定来源，并仅适配被动 OpenAI portable、Codex compatibility、Claude 本地 manifest/catalog 格式中的纯文本载荷。来源官方、声明 MIT 或 manifest 可解析均不等于宿主兼容或获准导入。

固定来源、提交、路径、内容摘要与策略的完整静态审核仍是必要条件。MCP、hooks、commands、agents、LSP、脚本、二进制和外部依赖保持阻断；固定 Remotion 快照仍为 DEPENDENCY_BLOCKED + REVIEW_REQUIRED，两层状态可同时成立。导入默认禁用，启用须独立确认；无自动去脚本变体、覆盖升级、回滚或离线目录缓存。

未运行 Electron GUI、实时上游、真实导入/启用、账户、凭据或设备控制；未做本地 SDK/EXE 打包。细节见 [兼容范围](../external-skills-compatibility.md)、[历史整合记录](2026-10-18-external-skills-followup.md) 和 [本次 verification JSON](2026-10-18-external-skills-pr-integration-verification.json)。
