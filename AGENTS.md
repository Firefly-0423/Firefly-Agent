# Firefly_Agent 工作约定

接手任务时先读取本文件、相关源码与现有计划，核对分支、工作树和验证记录。保护已有修改；从实际文件提取名称、路径、配置和接口，不推测标识。缺少精确信息时询问用户。

## 当前产品基线

当前 Firefly 仓库是唯一产品源码基线，模块职责与主入口见 `README.md` 的目录职责表。后续按模块维护现有实现；原项目仅可按需核对版权与来源，不作为默认正确实现，不在运行、构建、测试或打包中读取原项目工作树。当前产品不读取或迁移其他产品的安装数据；保留必要第三方许可与来源记录。工程独立不表示全部代码从零原创。历史施工报告用于追溯，不作为重新开启整仓迁移的计划。

## 按需使用 Skills

- 开始工作时使用 `superpowers:using-superpowers` 确认适用技能及其引用文件；不可用时如实说明。
- 接手任务或跨会话继续时，使用 `context-engineering` 整理必要上下文和已验证进度，优先沿用已有计划。
- 新功能需求或设计尚未明确时使用 `superpowers:brainstorming`；设计确认后使用 `superpowers:writing-plans`；已有确认计划时使用 `superpowers:executing-plans` 接续工作。
- 排查 Bug、测试或 CI 失败时使用 `superpowers:systematic-debugging`，先复现并定位。新增或改变行为时使用 `superpowers:test-driven-development`；保留已有实现和有效测试。
- 涉及框架、SDK 或依赖版本时使用 `source-driven-development`，核对项目实际版本和官方资料。
- 涉及依赖漏洞、鉴权、输入校验、敏感数据或外部调用时使用 `security-and-hardening`。
- 审查 PR、commit 或 diff 的安全风险时使用 `differential-review:differential-review`。先确定目标分支、基准提交和审查范围；历史或必要工具缺失时说明限制。
- 代码整理只对本次相关内容使用 `code-simplification` 并保持行为；一般质量审查使用 `code-review-and-quality`，与 Superpowers 的审查阶段合并，避免重复检查。
- 使用 `constraint-driven-development` 沿用现有质量要求。新增检查工具、调整阈值或修改 CI 策略前先与用户确认。
- 宣布完成前使用 `superpowers:verification-before-completion`，执行与改动相关且实际存在的测试、类型检查和构建，报告结果与未验证项。

按任务选择适用技能；简单修改无需运行完整流程。技能或引用文件不可用时说明，不能宣称已使用。不得为了套用技能重做已完成的方案或无关审计。
