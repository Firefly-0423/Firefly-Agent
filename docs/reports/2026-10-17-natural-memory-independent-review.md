> Historical snapshot: this file records its original phase1 baseline and acceptance time. For the user-selected mini target and final post-review source, see [fresh mini validation](../reports/2026-10-17-memory-token-mini-validation.md). Do not substitute its earlier counts or limits for current mini evidence.

# 阶段一自然语言低敏记忆：独立只读审查

审查时间：2026-10-17 07:35 UTC。工作树：`E:\Codex\2026-10-17\task\firefly-memory-phase1`；分支：`codex/natural-memory-phase1-20261017`；基线及未提交改动所在 HEAD：`0539f72a5888d1453227d3f3eabef410e23fbc58`。

## 结论

**当前建议：修复下列四项 Important 后重新验证，不建议按当前产品源码接受阶段一。** 未发现 Critical；未另列 Minor。四项均有离线执行证据，每项至少一条复现经过实际策略 writer 代码和纯内存 SQLite。它们不是由真实模型、用户数据库或服务产生的结果。

| 等级 | 数量 | 主要影响 |
| --- | ---: | --- |
| Critical | 0 | 未发现无需确认的模型 auto-ADD、记忆取得 system 权限等问题 |
| Important | 4 | 忘记屏障的规范化绕过、否定事实的旧快路径同步错误、极性证据错误、引用/假设被当作事实 |
| Minor | 0 | 不以风格意见阻塞本次工作 |

审查遵循 AGENTS.md、已批准计划及 code-review-and-quality / security-and-hardening / differential-review 的合并流程。上下文整理沿用现有计划；质量底线检查未见新增跳过测试、类型/静态检查抑制、依赖、DDL 或 CI 降标。未执行技能建议的源码 mutation 实验，因为委派明确禁止修改共享产品源码。

## Findings

### Important 1：many 类型的身份未规范化，忘记同一工具后可通过大小写变体重新建立事实

**位置：** `src/main/memory-policy/natural-protocol.ts:44`、`:50`；屏障消费点 `src/main/memory-policy/policy-repository.ts:139`。

`validateNaturalResponse` 用 NFKC 和小写校验证据，而 `typedUserFact` 对普通 tool/preference 只 trim，随后把原始 value 放入 many slotKey。`Vim`、`vim`、`Ｖｉｍ` 因此得到不同 subjectKey；来源重新产生于忘记后的新 generation 时，既有 subject tombstone 无法匹配这些等价拼写。

**已复现：** 在 `DatabaseSync(':memory:')` 中，经 `policy.extractNatural` 为 `我平时用 Vim` 提案并确认，随后忘记。新消息 `我通常用 Vim` 的结果为 `suppressed/forgotten`；新消息 `我通常用 vim` 却得到 `candidate`，普通 confirm 后成为 active，recall 返回 `用户使用工具：vim`。这与本批次已存在的“新消息仍受旧 shell tombstone 约束”行为不一致，也使规范化变体可并存。

**影响：** 同一用户概念绕过忘记后的显式 remember 屏障；仍需普通候选确认，故不归为 auto-ADD 或 Critical。可由模型仅改变 value 的大小写触发，无需特殊权限。

**建议：** 分离显示值与规范化身份值，对新增 typed many 身份统一 NFKC/大小写；写入、冲突、correct、suppression 都使用同一个版本化身份。保持旧 `policySubjectKey` 字节函数及既有 tombstone 的兼容，勿直接重写旧记录。增加 Vim/vim/全角和同一原文不同模型大小写的回归。

### Important 2：旧确定性重复判断忽略 typed polarity，明确改用同一工具仍保留否定事实

**位置：** `src/main/memory-policy/policy-repository.ts:220`，同类旧 ingest 分支在 `:310`；typed 候选构造点 `:113`。

新 typed 记录可以存 negative，但旧快路径只比较 `owner.extraction.value === claim.value` 即增加 duplicate support。它没有检查 typed polarity/assertionKey，并先于真正的 change 更新分支返回。

**已复现：** 自然输入 `我平时不用 PowerShell`，negative 候选确认；时间更晚的 `我现在改用 PowerShell` 经真实 `policy.integrate` 返回 `active`、`factRevision:1`、`reason:'duplicate-support'`。随后 recall 仍是 revision 1、`用户使用工具（否定）：powershell`、`typed.polarity:'negative'`。

**影响：** 用户明确更正没有生效，反而让相反原话成为旧否定事实的有效 support；新会话会继续使用错误记忆。这是无需坏模型即可触发的普通用户路径。

**建议：** typed duplicate 以完整断言身份判断；相反极性不能直接加 support。已满足时间顺序与 baseline 的显式 change 应生成新 immutable revision，保持 typed、core assertion、supports 一致。检查 integrate 和 ingest 两条重复分支；补 negative shell/language/style 到同值 positive 的回归。

### Important 3：极性验证既漏掉常见否定，又把另一分句的否定套给证据

**位置：** `src/main/memory-policy/natural-protocol.ts:15`、`:32`、`:36`。

极性判断是对整个句子运行一个有限正则，和模型 polarity 作一次布尔相等比较。`I no longer use Vim`、`我没有使用 Vim` 不匹配 NEGATIVE，正极性模型结果因而通过。另一方向，`我不用 Vim，但我平时用 Emacs` 中模型引用精确正向证据 `我平时用 Emacs`、却给 Emacs 标 negative，也会通过，因为前一分句命中“不用”。

**已复现：** 以上纯函数检查均 accepted=1；混合分句结果为 `{value:'Emacs',polarity:'negative',quote:'我平时用 Emacs',span:{start:9,end:19}}`。`I no longer use Vim` 还经过完整 Main → writer → pending candidate → confirm，结果 active。

**影响：** 所谓 worker validated candidate 可以与用户原话相反；后续版本/hash/scope 确认只能绑定这个错误内容，无法补回缺失的证据校验。仍有确认门，因此归 Important。

**建议：** 在统一规范化后的具体证据分句中校验所指关系和极性；无法可靠归属的混合/转折分句保守拒绝，不要借其他分句的否定批准候选。覆盖 no longer、没有，以及一条消息中多个不同极性的工具陈述。

### Important 4：单引号引用和愿望/无问号问句可以变成持久事实

**位置：** `src/main/memory-policy/natural-protocol.ts:16`、`:33`、`:35`。

NON_FACT 拦截双引号、部分词和问号，但不包含 ASCII/弯单引号，也不识别普通 wish/询问意图。仅出现 I/我和同值子串，就足以让这些句子通过 asserted 校验。

**已复现：** `‘我喜欢 Emacs’ 这句话是什么时态`（preference=Emacs）、`I wish I used Nano`（tool=Nano）经完整 Main → writer 均生成 typed candidate，普通 confirm 后 active。纯函数检查还接受 `我想知道用 Vim 能做什么`、`我只是问问，我用 Vim 能有什么好处`。它们没有断言当前耐久偏好。父任务新加的 ASCII 单引号回归也针对同一缺口。

**影响：** 引用、愿望和提问会产生带“直接用户陈述”标签的候选与 evidence；这违反阶段一不从引用/假设/一次性问句抽取的约束。依赖模型自己标 needs-confirmation 不能替代独立 validator。

**建议：** 统一处理匹配的引号边界、元语言上下文和常见非事实语气；对语义不明确的句子返回空提案。不要全局禁止所有英文 apostrophe，以免把 don't 等正常否定排除；明确区分配对引用和词内撇号。增加无问号询问、wish、ASCII/Unicode 引用及正常肯定/否定不被误伤的回归。

## 已审查的边界与历史

- `git diff BASE` 的 17 个跟踪文件（+252/-47），加上计划和四个未跟踪源码/测试文件，合计 22 个变更文件均已阅读；重点深入 15 个产品文件及一跳依赖。仓库约 1813 个 TS/TSX 文件，按 LARGE/SURGICAL 处理，不声称完成整仓安全审计。
- 追踪链路：成功的桌面 Chat 回调 → `extractNatural` → generation/source snapshot → model → worker 二次校验 → evidence/core candidate/policy row → hash/revision/scope confirm → supports → selector → canonical Context/dispatch 复核。
- 复核了临时会话提前退出、模型/assistant/history 来源拒绝、项目 actor 拒绝、旧 candidate 失效、新 candidate 关联、独立确认来源、来源 pending/stale/deleted、当前 subject 冲突、忘记 generation、旧 nomination 复核、事务回滚及统一 transactionNow。除上述 findings，未在这些路径发现可证实的同等级缺陷。
- 两条 memory prompt 路径均复用固定 system guard + user JSON 数据。持久化 assertion 不再拼入 system/developer 内容；固定 guard 不赋予工具权限，现有 host 权限边界仍独立执行。
- source/model 配置变化及 shutdown 的代码检查表明 abort、再次读取来源、再次 scope 检查、worker generation/source 检查和 drain 仍在；本轮未启动真实宿主做并发负载实验。
- 基线 blame：`policySubjectKey` 的哈希形状来自 `82461a3e`（2026-10-16），本次只是原样移至 fact-identity；core 显式 activation/suppression 条件来自 `39da2493`（2026-10-01），本次未移除。memory data 的旧 system 角色来自 `38d60b57`（2026-10-06），本次已改为数据角色。没有发现删除既有安全检查的历史红旗。
- 生产引用计数（含定义，仅作可复查的静态触达量）：eligibleFactsWithinTransaction 8 处、parseNaturalEdit 5 处、validateNaturalResponse 2 处；extractNatural 仅由 desktop default owner 调用。主存 eligibility 也被 recall/context/history 使用，因此 typed 一致性会影响实际 canonical 上下文，不能只测设置列表。

## 验证与覆盖限制

本审查只写此报告，没有改产品源码、索引、HEAD、分支、测试文件或依赖。所有专项执行均为 PowerShell here-string → `node -`，读取已安装 TypeScript 编译器，在进程内 transpileModule，不 emit 文件；writer 实验使用 `DatabaseSync(':memory:')`、随机合成 key、内存 source provider 和 fake model。没有调用真实模型、Electron、网络、数据库或用户 UI。

| 本轮证据 | 实际结果 |
| --- | --- |
| 纯函数坏输入、身份规范化专项 | 复现 Important 1/3/4；进程退出 0 |
| 纯内存 writer：forget + case variant | 同值 Vim suppressed；vim candidate → confirmed active |
| 纯内存 writer：negative shell + 后续确定性 change | duplicate-support，revision 未增加，negative 保留 |
| 纯内存 writer：no longer / 引用 / wish | 三者均 candidate → confirmed active |
| `git diff --check` | 退出 0 |
| diff 的新增 skip/only/类型抑制检索 | 未发现新增项 |

已读父任务的最新角色验证日志：三个文件 179 tests passed；这属于父任务证据，不声称本审查重跑该套件。父任务还报告 Main 类型检查通过，较早相关回归 1710 passed / 5 平台 skip / 1 个进程缓存旧角色导致的失败；冻结后的全量与新 findings 的 RED→修复→GREEN 尚由父任务负责，本报告不把在跑或新写的测试当通过。审查结束时父任务已开始补上述发现的回归，产品文件哈希仍为下列快照。

不判断的范围：真实 provider 的抽取准确率、真实 Electron/UI 验收、用户数据库升级/恢复、线上凭据与网络、完整依赖 advisory 扫描、Android、原用户 chat-ux 工作树。未运行突变测试、真实关闭竞态/负载测试或完整项目构建。关键词敏感筛查也不是完整 DLP 保证；本轮不将所有未列出的自然语言或敏感类别推断为已安全覆盖。

模型要求：委派指定 gpt-6.1-sol/max。本审查未请求任何模型/推理档位替换；执行环境未向本 turn 返回可独立读取的有效采样配置，因此不能用本报告认证实际采样参数。此可验证性限制已由既有计划记录，不能把全局默认档位当作本任务档位证据。

## 审查快照

| 文件 | SHA-256 |
| --- | --- |
| natural-protocol.ts | `22C1F5FDD6DB2F12DC891D4DA36677D80AFC30759419F380A7CDC4F040D2F486` |
| policy-repository.ts | `B4B6D96983CAEDB2C86B753EB17815E91DFEC3326D19E009BCF09A04142F8BBB` |
| memory-settings-ipc.ts | `B6A02A234EFBB663E502CAB92186AFF887860D587F05432FE67CFE7109C7FBAC` |
| fact-context-messages.ts | `F1707A1742C1C4970B53AAB043B4637316381817F8DFC6AB6BF8BCD0BF450A3B` |

置信度：四项 findings 的复现与根因为高；在列明的代码信任边界内为中高；真实模型/真实应用和完整语言覆盖不在此结论范围。未遇到自动审批拒绝、待审批操作或不确定的写入结果。
