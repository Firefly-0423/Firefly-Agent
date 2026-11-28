---
hiddenFromUi: false
modes: [code]
name: as-using-agent-skills
description: "Discovers and invokes agent skills. Use when starting a session or when you need to discover which skill applies to the current task. This is the meta-skill that governs how all other skills are discovered and invoked."
---

# 工程技能选用记录

这个历史夹具记录按任务阶段选择工作流程的方式。技能的作用是提供可执行步骤；不能因为列出了某个技能，就假设当前环境已经安装或能够调用它。

## 先识别当前阶段

用户还说不清目标时，使用 `interview-me` 提取需求。需要发散几个候选方案时，使用 `idea-refine`。新增项目、功能或较大改动先用 `spec-driven-development` 明确边界；规范已有但缺任务安排时，选择 `planning-and-task-breakdown`。

实现阶段采用 `incremental-implementation`。界面工作对应 `frontend-ui-engineering`，公开契约对应 `api-and-interface-design`；缺项目背景时用 `context-engineering`，需要核对官方资料时用 `source-driven-development`。陌生或高影响代码可引入 `doubt-driven-development` 重新质疑关键假设。

编写与运行测试时，选择 `test-driven-development`；浏览器验证可补充 `browser-testing-with-devtools`。已有故障从 `debugging-and-error-recovery` 开始，先建立可复现事实。

审查阶段使用 `code-review-and-quality`。复杂度、输入安全和性能问题分别由 `code-simplification`、`security-and-hardening`、`performance-optimization` 补充。

提交与分支工作对应 `git-workflow-and-versioning`，流水线对应 `ci-cd-and-automation`，文档与架构决定对应 `documentation-and-adrs`，观测能力对应 `observability-and-instrumentation`，迁移退役对应 `deprecation-and-migration`，部署上线对应 `shipping-and-launch`。

## 执行时必须保持的习惯

开始非简单实现前，列出影响方案的假设，尤其是需求范围、架构限制和未确认的行为。给用户纠正机会，不要把空缺自动填成自己的偏好。

遇到互相矛盾的要求，先暂停依赖该决定的步骤。指出冲突所在、可选解释及其代价，等待必要澄清。对已经能够独立推进的部分，保持既有任务边界。

发现方案明显有问题时直接解释具体后果，并提出替代做法。尽量用时间、成本、复杂度或故障方式来说明。用户理解取舍后作出的决定仍应被尊重。

实现以清楚、足够简单为准。每个抽象都需要说明它解决了什么；避免为了可能的扩展写出大段无人需要的机制。完成前再次检查能否删去没有价值的间接层。

只处理用户授权的范围。不要顺手整理相邻系统，不删除尚未理解的代码，不因为某项能力“看起来不错”就自动增加它。注释背后的原因要先理解再修改。

验证必须留下证据。通过的测试、构建结果和运行观察需要与未验证项区分。技能本身的验证步骤与项目整体完成要求同时适用；相关完成约定见 `../../references/definition-of-done.md`。

## 组合技能的顺序

完整功能通常经过需求澄清、方案比较、规范、任务拆分、上下文准备、资料核对、分步实现、测试、审查、简化和交付。观测工作应与实现、测试同步安排，不能到上线后才补。

一次缺陷修复通常只需要定位、回归验证和相关审查。任务不需要的阶段可以省去，但已经选用的流程步骤不能随意跳过。每次任务先检查是否存在适用技能，而非只凭习惯重复同一个流程。

发现流程不存在、工具不可用或引用文件缺失时如实说明。不要把没有执行的检查写成“已通过”，也不要通过更改检查标准制造完成状态。

## 常见偏离

- 未核验的假设一路传播到实现中。
- 明明发现矛盾仍继续猜测。
- 为了迎合用户而掩盖明确的技术代价。
- 简单问题被包装成大量抽象与配置。
- 修改超出当前任务的代码和行为。
- 测试、运行证据和实际完成范围不一致。

这些信号出现时，回到当前目标、授权边界和最新证据，调整正在进行的步骤。
