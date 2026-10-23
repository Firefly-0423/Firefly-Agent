# 外部技能市场第一批：诊断、修复与验证记录

日期：2026-10-18 UTC。开发目标 `firefly-mini-v1.1.x`；实施基线 `88443aa28a184ea3f7cec17b698fce1a2ca8b547`。独立工作树 `E:/Codex/2026-10-18/task-2/firefly-external-batch1`，分支 `codex/external-skills-batch1-20261018`。功能与审查修复测试提交 `6f237ec268dd57590ff1f9ce246bc917112f689c`；最终报告提交只更新文档。

验证期间公开目标已前进到 `770633107d908aacfb5b05063b3df196715a467b`，新增内容仅为已合并的插件市场修复 PR115（`2d53b41`）。只读取得该提交并比较文件列表，与本批实际改动无重叠；没有把对方补丁手工拼入本工作树。本报告的测试是 `88443aa` 基线加本批提交，不声称已经验证与 PR115 合并后的组合；父会话集成时须保留组合 CI。证据：`audit/batch1/final-target-overlap.json`。

## 结论与交付

- 截图中 `DEPENDENCY_BLOCKED` 与 `REVIEW_REQUIRED` 可以同时成立。前者是已确认的宿主不兼容，后者是缺少本宿主精确审批；不是“安装一个依赖即可继续”。原界面完整准备失败后保留旧预览，造成顶部与正文状态不同步，这是真实实现缺陷。
- 已修复失败状态刷新、异步身份/版本竞争和 Work/Code 说明；增加最新发现、已审核固定快照、已安装版本的分离展示。审批继续精确绑定来源、提交、路径、全部字节摘要和政策，不转移到 HEAD。
- 增加 OpenAI portable/Codex 与 Claude 本地声明的保守只读适配和具体阻断原因；没有增加可执行宿主、候选依赖安装、自动删减包或新的真实技能审批。
- 独立审查发现 3 项重要问题，已用失败回归复现后在一轮修复中处理；2 项轻微问题明确保留并记入下文。固定 Remotion 原包仍阻断。
- 最终全量测试：**10702 通过 / 0 失败 / 11 既有跳过，873 文件**。专项、编译和构建证据见下表。没有推送、创建本批 PR、合并、部署或 SDK/应用安装器打包；父会话协调后续 PR。

## 截图状态与可复现根因

| 截图信息 | 实际含义 |
| --- | --- |
| `remotion` / `1.0.7` / MIT | 所属包 manifest 的声明；MIT 标签不能替代适用许可全文和逐文件范围审核 |
| `remotion-markup` / `4.0.506` | 选中 SKILL.md 的元数据，与包版本分离 |
| 提交 `0722921d5542fc593105c27bd52630babd8b8c2a` | 发现、tree、blob 和审核所绑定的固定版本 |
| 声明已核对 | 路径位于包声明的技能入口中，尚未表示内容或宿主能力兼容 |
| 完整内容尚未审核 | `preview.complete=false`；清单大小和元信息预览不是完整内容审核 |
| `DEPENDENCY_BLOCKED` | 完整准备已确认原候选包含不支持内容或必需能力；准备失败，不生成有效导入 token |
| `REVIEW_REQUIRED` | 缺少 source/commit/path/digest/current-policy 精确匹配的 Main 静态审批 |
| “完整审核内容” | 请求完整下载、核验和合格时的暂存准备；点击不创建人工批准，不等于导入或启用 |

原失败路径：预览返回仅有 `REVIEW_REQUIRED`；Main 完整评估缓存 `[DEPENDENCY_BLOCKED, REVIEW_REQUIRED]`，prepare 优先返回依赖错误；Renderer 仅设置顶部消息，保留旧 selected，因此正文仍待审核且按钮可重复点击。修复后先清除旧可操作详情，在同一 generation/source/id/repository/path/commit 下重新取详情；失败详情读取也失败则不恢复旧可提交状态。限流、可重试网络失败和快照失效要求手动刷新，避免自动重试请求。

主要位置：[`ExternalSkillsPanel.tsx`](../../src/renderer/react/features/chat/components/ExternalSkillsPanel.tsx) 53、121、140 行起；[`external-service.ts`](../../src/main/skills/external-service.ts) 313、343、389 行起；[`external-review.ts`](../../src/main/skills/external-review.ts) 完整评估与精确审批匹配。React 测试覆盖失败详情迟到、来源/版本切换、准备提交不符、刷新再失败及旧按钮失效。

第二个原缺口是仅发现 HEAD，唯一已审核的旧版 Anthropic frontend-design 无可选入口。本批由 [`external-revisions.ts`](../../src/main/skills/external-revisions.ts) 选择 Main 审核表中当前政策下唯一最新记录，由 service 214 行起按固定提交发现。Renderer 的 `latest/reviewed + expected commit` 只是断言；任意提交、路径或审批对象不获授权。已安装身份另由 committed 状态、所有权和全部安装字节验证。HEAD 删除技能或成为合法空目录不会删除已审核条目；网络/目录错误仍显式失败。

## Remotion 原字节验证

使用最终编译后的生产 source/manifest/frontmatter/review 模块，注入本任务已保存的固定 Git 树和原始 blob。逐文件 SHA-256、Git blob SHA-1 和字节数均核对；未联网执行该验证，未导入、暂存或运行候选。

```text
repository: openai/plugins
commit: 0722921d5542fc593105c27bd52630babd8b8c2a
path: plugins/remotion/skills/remotion-markup
files: 58
bytes: 561339
canonical SHA-256: be1b704d0941cf8537a91753714e54705a74e6b88245d3c314b21aeb474e614d
declaration: verified
review: blocked
blockers: [DEPENDENCY_BLOCKED, REVIEW_REQUIRED]
issues: 57 file + 2 text + 18 instruction
```

同一文件可产生多个类别的记录。只有根 SKILL.md 符合当前布局；其他内容包括平铺 Markdown、深层地图资料、2 份 MJS、3 份 TS、2 份 PNG、JSON/GeoJSON 与 agent YAML。入口引用兄弟 `remotion-best-practices`、`remotion-interactivity`、`remotion-captions`；正文流程还需要 React/Remotion、CLI/Studio、按功能需要的外部语音或地图服务。完整原包因此不属于本宿主目前支持的指令载荷。不能静默删去这些文件或引用后复用原身份。

这次不是体积、路径或 executable bit 超限：全部文件 mode 为 100644，最大文件 333134 字节；58 文件与总字节低于现有阈值。没有精确审批且目录未提供适用许可全文，不能把包的 MIT 声明当作许可审核完成；本次实际错误集合没有另行虚构 `LICENSE_BLOCKED`。

上游原证据：[固定目录](https://github.com/openai/plugins/tree/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/remotion/skills/remotion-markup)、[SKILL.md](https://github.com/openai/plugins/blob/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/remotion/skills/remotion-markup/SKILL.md)。完整逐路径原因和可重跑 harness 位于本任务 `audit/batch1/real-remotion-result.json`、`validate-real-remotion.cjs`；最终运行日志 `final-real-remotion.log`。这是生产模块受控验证，未声称真实 Electron 或网络端到端验收。

## 当前支持与安全边界

完整支持范围见 [兼容说明](../external-skills-compatibility.md)。载荷仍仅允许根 SKILL.md、适用 LICENSE/NOTICE 类文本，以及一级 `references/*.md|*.txt`；必须全部保留、UTF-8、普通 Git 文件，且通过数量、大小、路径、哈希、内容和逐文件许可覆盖校验。来源始终仅两个固定仓库。来源官方身份和上游宿主审批均不代表 Firefly 兼容。

OpenAI portable 的 inline overlay 替换 legacy overlay；无 inline 时才回退。Claude 仓库根条目的显式 skills 选择保持限制，普通子目录包支持默认及额外路径，strict:false 的双重组件声明会阻断。非空 MCP/hooks/agents/commands/LSP 等不会接入本导入器；空 MCP 配置只做惰性 JSON 读取。格式依据：[OpenAI package](https://developers.openai.com/plugins/build/plugins)、[Claude manifest](https://code.claude.com/docs/en/plugins-reference#marketplace-entries-and-the-manifest)、[Claude marketplace display fields](https://code.claude.com/docs/en/plugins/marketplace-reference#display-fields)。这些规则用于保守适配，不声称实现完整上游运行时。

审批政策为 `firefly-instruction-only-v1`。没有新增真实批准项；原 frontend-design 记录只对其原提交和原字节生效。导入仍为完整审核→一次性 owner/frame token→确认提交，导入默认禁用；已安装页另有启用确认。现有 token 失效、可信 frame、独占目标、证明式回滚、启动恢复、Work/Code 注册和篡改阻断保持。旧安装若未记录 policyVersion 会明确显示未记录，不因此新增当前审批或导入权限。

## 独立审查与处理

新鲜 gpt-6.1-sol/max 审查覆盖 `88443aa..b131aaa` 全部 31 个改动文件及调用者/历史，执行两组只读内存 fixture。原始报告 `audit/batch1/independent-review.md`；评价是修复前 head 不应合并，不是对后续修复的重新审查。

| Finding | 处理与证据 |
| --- | --- |
| I1 portable fallback 的嵌套扩展漏检 | 共用 Codex 扩展检查；inline 的额外嵌套阻断。fallback/inline 两条精确审批 fixture 先失败后通过，服务层拒绝且零暂存 |
| I2 Claude root 选择扩大、strict 冲突被接受 | discovery 与 declaration 同时限制 root 显式目录；冲突给出目录路径。root/strict 两条核心回归先失败后通过，另验 disjoint root 不冲突 |
| I3 目录 MIT 标签遮盖 manifest 限制许可 | 所有读取的声明使用原有许可集合检查，展示优先级不清除阻断。catalog/overlay 两条核心回归先失败后通过；另验被遮盖畸形声明拒绝、服务零暂存 |
| M1 Claude 包版本优先级 | **延期**：目录和 manifest 同时有 version 时仍优先目录值。展示及持久化 bundle 元数据可能不准；固定 commit/digest 与审批不受影响 |
| M2 元数据文件模式的诊断路径 | **延期**：不支持的 manifest/config mode 在读取前安全拒绝，但仅有通用依赖错误，缺少 file-mode 路径说明 |

未增加第二次审查；按一次独立审查、一轮重要问题修复及全套回归交付。扩大专项还捕获旧 application wiring 测试 fixture 只剥离两个旧只读字段的问题；按 Main 实际发布行为补剥离新增四字段，保留全部严格状态校验与原恢复断言。

## 实际测试与环境

全量及专项的日志、隔离 npm/Cargo cache、配置、synthetic 用户和临时数据位于 `E:/Codex/2026-10-18/task-2/audit/batch1`；4 项 Node 脚本测试中的报告器自测另在系统允许的 Temp 创建独占 fixture 并清理。Node 24.19.0、npm 11.17.0、Vitest 4.1.11。没有引用其他任务的 node_modules、helper、配置或用户数据。

`npm ci --ignore-scripts --no-audit --no-fund` 首次 ECONNRESET，重试按原 lockfile 成功（1076 packages）；只显式执行本仓库两个受哈希约束的安全 backport 到本任务 node_modules。项目现有 native presence 测试要求 helper，因此用项目 locked Rust 源码在本任务独立 Cargo cache/target 编译该测试辅助程序；未调用应用/SDK 打包流程。

| 实际命令/范围 | 结果 | 日志 |
| --- | --- | --- |
| 核心审查回归，修复前 `npm test -- external-manifests.test.ts` | 6 预期失败 / 22 通过 | `review-fixes-red.log` |
| `npm test -- external- ExternalSkillsPanel.test.ts SkillModePanel.test.ts`，最终扩大专项 | 772 通过 / 1 既有跳过，23 文件 | `review-fixes-regression-green.log` |
| 首次完整 `npm test` | 10701 通过 / 1 稀疏检出失败 / 11 既有跳过 | `full-suite-final.log` |
| 补取原跟踪文件后 `npm test -- structure-cleanup.test.ts` | 6/6 通过 | `sparse-resource-recheck.log` |
| 补齐所需跟踪文件后的最终 `npm test` | 10702 通过 / 0 失败 / 11 既有跳过，873 文件 | `full-suite-complete-checkout.log` / 最终 archive |
| `node node_modules/typescript/bin/tsc -p tsconfig.main.json` | exit 0，真实生成 Main 模块 | `final-main-compile.log` |
| `npm run build:preload` | exit 0 | `review-preload-build.log` |
| `npm run check:renderer` | exit 0 | `review-renderer-types.log` |
| `npm run build:renderer` | exit 0；现有大 chunk 提示 | `final-renderer-build.log` |
| `npm run check:storage-boundary` | PASS，88 allowlisted accesses / 46 files | `final-storage-boundary.log` |
| `node --test scripts/testing/run-tests.test.mjs scripts/testing/archive-reporter.test.mjs` | 4 通过 / 0 失败 / 0 跳过 | `final-node-testing-scripts.log` |
| `node E:/Codex/2026-10-18/task-2/audit/batch1/validate-real-remotion.cjs` | 实际生产模块，原始全量载荷继续阻断 | `final-real-remotion.log` |
| `git diff --check` | exit 0（最终提交前后复核） | 最终收尾记录 |

最终专项 archive：`tmp/firefly-test-reports/2026-10-18T03-45-20-680Z-f154a7a2-9c1a-4244-9d00-ef09003caa9a/report.json`。唯一跳过是 `external-state.test.ts / stale_lock_fail_closed preserves linked lock and all remaining bytes`，Windows `ERROR_PRIVILEGE_NOT_HELD (1314)`；没有新增 skip 或放宽安全断言。此前 19 文件/736 通过记录只是较窄范围，不能替代这次扩大专项和最终全量。

首次有完整结果的全量在干净 `6f237ec` 上为 10701 通过、1 失败、11 跳过（873 文件，809.92 秒，无未处理错误）。唯一失败是 `structure-cleanup.test.ts / has valid file targets in the license and readme links`，原因是本任务稀疏工作树没有取出 `readme-assets/ICON_SOURCES.md`。`git ls-files -t` 显示它为 skip-worktree；原基线、当前 HEAD 和补取后的工作文件 blob 均为 `630f10de83d645cd7cbca71c6df3a6761e813f68`。只用 `git restore --source=HEAD --worktree --ignore-skip-worktree-bits -- readme-assets/ICON_SOURCES.md` 补取该原文件，Git 状态仍干净，6 项结构测试全部通过；没有修改产品、链接检查或断言。随后才执行表中完整确认，失败记录未被删去。

首次全量运行已中止，**不计作通过**：测试导入 `electron/index.js` 自动触发依赖自身的 `install.js`，即使 npm ci 禁用了生命周期脚本。检查证实 Electron 下载在中止前已完成，仅落在本任务 node_modules/dist 和隔离缓存；未启动 Electron，未发现残留本任务 Node 子进程，下载目录/标记/缓存经绝对路径验证后已清理。后续 runner 使用依赖支持的 `ELECTRON_OVERRIDE_DIST_PATH` 指向本任务空目录，避免再次下载；未修改依赖源文件或测试断言。Node 报告器另生成的合成“skip/todo”日志属于报告器 fixture，不是实际 4 项测试的跳过。

## 决策、后续与未执行项

以下对应 ledger 全部 `Ruling:`，含独立审查不作判断的范围：

1. 可重试网络/限流失败或过期快照清除旧详情、要求手动刷新，维持无自动重试政策；代价是一次额外导航/刷新。
2. 合法 `plugins:[]` 允许为空以保留旧审核入口；非空但无有效候选仍拒绝；代价是调用者须区分空目录与错误，已覆盖测试。
3. 测试使用 Electron 官方路径 override 阻止自动下载；代价是这些 Node 测试不能验证 Electron 二进制行为。
4. 实际 MCP 执行、设备连接器、可执行技能宿主留后续批次；代价是这类候选仍不可通过纯文本导入。
5. 保留 TARGET_EXISTS，不自动替换、升级或降级；代价是更换版本需单独明确的生命周期操作。
6. 网络/目录失败不做离线或持久缓存回退；代价是上游不可用时审核入口也可能不可达。
7. 对另一插件任务仅按提供路径只读核对，不集成其补丁；代价是父会话须另验合并后的组合。对方 `2d53b41` / [PR115](https://github.com/Serendipity-wu02/Firefly-Agent/pull/115) 与本批实际改动文件无重叠，外部 boundary 源码预像测试未被本批改动。
8. 不作新增的全部依赖、安装器、部署或同一 OS 用户内核隔离审计；代价是未改动区域的这些风险未由本次专项证明。
9. 合成真实模块/文件系统及 React JSDOM 验证不替代真实 Electron 像素、实时上游、账户或设备验收；代价是这些集成场景仍未实际验证。

未执行真实候选导入/启用、候选脚本/生命周期、付费模型、真实凭据/设备操作、SDK/应用 EXE 打包、推送/PR/合并/部署。原启用确认仍是可信 Renderer 的独立确认流程，不声称新增 Main 用户同意凭证或 OS 级隔离。后续验收顺序为先处理 M1/M2，再在获授权的隔离运行实例中进行 GUI/上游端到端；执行型候选另立能力与许可范围设计。

本次没有自动审批拒绝或等待用户批准的动作。没有剩余执行阻塞；两项延期轻微问题、GUI/实时上游未验收及与 PR115 的组合 CI 限制如上。

最终全量 archive：`E:/Codex/2026-10-18/task-2/audit/batch1/tmp/firefly-test-reports/2026-10-18T04-02-15-184Z-3c0d6281-4004-4d31-94f1-e5b7505522a6/report.json`。完整计数、起止干净提交、11 项原始跳过及独立源码条件见 [验证证据](2026-10-18-external-skills-batch1-verification.json)。原始独立审查见 [审查报告](2026-10-18-external-skills-batch1-independent-review.md)。
