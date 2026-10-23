# 外部技能市场：尾项与最新基线整合验收

本批完成两个已报告轻微问题，并在独立本地分支整合最新 `firefly-mini-v1.1.x`。没有新增审批、扩大执行组件支持、改变安全政策或修改真实运行配置。

## 修复与证据

- `src/main/skills/external-manifests.ts`：Claude 包版本优先读取 manifest，再回退目录条目和已有公共目录元数据，符合上游 manifest 版本覆盖语义。服务层测试确认 canonical 版本写入安装记录且默认禁用。
- 同一模块只将内部“不支持 metadata 文件模式”转换成 blocked 详情，在读取不支持 blob 前返回经过路径校验的仓库相对 `file-mode` 证据，保留此前组件阻断。不输出本机缓存、暂存或配置路径；其他异常仍传播，不能创建暂存或导入。
- 回归位于 `external-manifests.test.ts` 和 `external-service.test.ts`；RED 12 失败/111 通过，GREEN 123/123，通过后扩展外部市场/React 回归 788 通过、1 个既有 Windows 1314 跳过（23 文件）。
- Claude 格式适配、纯文本政策及完整目录审核仍保留，具体范围见 [兼容范围](../external-skills-compatibility.md)。历史首批报告不改写。

## 整合身份

原首批分支保持 `ad392a5420966a1dd4233f4f51a6233162513fbd`，尾项分支保持 `2b4a6f9461a5dd5e2a56fffa3f9f5a16f1544846`。本地整合分支 `codex/external-skills-integrated-20261018` 从实际最新目标 `770633107d908aacfb5b05063b3df196715a467b` 创建，依次重放六个提交，测试代码为 `2d2d35b9c44ced39fbfee02fbc86aceaa3138e9c`。

六项 range-diff 均等价。原尾项到整合代码的完整差异恰为目标 PR115 的十个文件；原提交及 Claude、renderer、vendors、依赖和 native 内容均保留。PR115 已存在目标分支，本批没有改写它或再建重复 PR，也没有向任何目标分支 merge。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| 外部市场与 PR115 相关 plugin marketplace/runtime/manager/version-store 组合回归 | 1001 通过、2 个既有 Windows 1314 跳过；33 文件 |
| 整合后项目全量 `npm test` | 10755 通过、0 失败、11 个既有跳过；874 文件（873 通过、1 跳过）；923.66 秒 |
| Main 编译、preload 构建、renderer 类型检查及构建 | 全部 exit 0 |
| 未修改的存储边界检查 | PASS：88 处访问、46 文件 |
| 缓存 Remotion 固定字节复验 | 58 文件、561339 字节、摘要不变；继续 DEPENDENCY_BLOCKED + REVIEW_REQUIRED |

全量测试在干净的 `2d2d35b` 开始和结束，未处理异常 0。机器可读摘要和逐项跳过原因见 [verification JSON](2026-10-18-external-skills-followup-verification.json)。详细日志、原始 archive、提交映射和 preflight 在本任务 `audit/followup/`。跳过只来自已有平台守卫或 Windows 文件符号链接权限，未修改测试或阈值。

沿用独立依赖、测试用户和临时目录，显式设置空 Electron runtime override，未新增下载或安装。切分支移除了 sparse checkout 中原先恢复的 README 目标文件；在本次全量运行前，从同一个已跟踪 Git blob 恢复并检查。没有将缺文件当作产品故障或放宽断言。类型检查曾发现新诊断数组字面量拓宽，已用 `as const` 修复，后续检查通过。

上述验证包含项目自有的合成插件 fixture；Remotion 候选只读解析，没有安装或执行。没有运行 GUI、真实导入/启用、账户/设备连接、付费模型调用、SDK/EXE 打包安装、推送、PR 或部署。设备模拟属于后续独立批次，本记录不宣称它已完成。
