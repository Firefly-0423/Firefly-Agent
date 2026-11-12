# 文档与工程施工计划

状态：待施工
规格：无独立规格；依据 `output/cyrene-inventory.md` 的盘点条目与负责人 2026-11-12 的决定。

**目标：** 为用户提供中英文免责声明和三份渠道接入指南，准确解释 Firefly 的许可、角色素材来源、数据去向、AI 输出风险、工具授权及渠道限制。用户能够按照 Firefly 的中文界面完成配置，识别“连接成功但消息被拒”“工具关闭”“被动回复额度耗尽”等不同情况，并知道如何安全排障。为维护者建立可追溯的生产依赖风险登记和测试入口清单，补齐默认 Vitest 集合以外的 CI 测试覆盖。

**架构：** 全部以仓库文档实现，README 链接入口，不增加首次启动同意弹窗、持久化同意记录、IPC 或错误码。免责声明随安装包离线附带。渠道指南按现有适配器的实际行为编写；文档与实现不符时先纠正文档，实际缺陷单独立包修复。依赖风险用 Markdown 登记表维护。CI 在现有 `test.yml` 上补入 Node 脚本测试和有运行前提的独立验收入口，并让开发分支的 push 也触发。

**不改的东西：**
- 渠道适配器、渠道 IPC（`IPC.CHANNELS_GET_CONFIG`、`CHANNELS_SAVE_CONFIG`、`CHANNELS_GET_STATUS`、`CHANNELS_SENDER_RESOLVE`、`CHANNELS_QQ_TEST_CONNECTION`、`CHANNELS_QQBOT_TEST_CONNECTION`，`src/main/channels/init.ts:71-109`）和 `ChannelStatus`；不新造产品错误码。
- `LICENSE`、`MODEL_LICENSE.md`、`THIRD_PARTY_NOTICES.md` 的许可内容。
- 默认 Vitest 的 include、超时、worker 设置，生产依赖审计的非阻断策略；不降低断言、不放宽阈值、不删用例。
- 不升级依赖、不改锁文件、不运行自动修复；不新增漏洞扫描器或检查工具。

## 现状

### 文档与产品边界

- `AGENTS.md` 的“修改与验证”和“测试断言写法”十二条适用于本计划全部施工包。
- README 已说明模块职责：渠道位于 `src/main/channels/`，界面位于 `src/renderer/`，共享契约位于 `src/shared/`，启动隔离位于 `src/main/startup/`。证据：`README.md` 的“各层代码位置”“项目结构”。
- README 已有安全、权限、本地数据和外部服务说明；代码使用 MIT 许可，角色素材另有说明。证据：`README.md:115` 起、“许可证与角色素材”章节、`LICENSE:1`。这些内容保留并链接完整条款，不重新编写许可。
- `git ls-files '*disclaimer*' 'docs/user-guide/*'` 无输出：缺少独立免责声明与渠道指南。
- 默认正式数据目录仍是 `%APPDATA%\Firefly`，尚未按版本隔离。证据：`src/main/startup/runtime-profile.ts:55-56`、`README.md`“数据位置”。1.2.0 定为 `%APPDATA%\Firefly-1.2.0`，由启动隔离施工落实；新文档在它落地前不能声称已使用新目录。

### 渠道实现

| 项目 | 当前实现与证据 | 本计划处理 |
|---|---|---|
| 飞书 | 官方 SDK；只接受 `p2p`；调用 `admitSender`；支持多种媒体发送。`src/main/channels/adapters/feishu/index.ts:4,14,71,124,128` | 写指南；删除“无白名单”的旧假设 |
| 飞书默认准入 | `allowAnyPrivate: false`，`allowedSenderIds: []`。`src/main/channels/settings-store.ts:37` | 说明首次消息可能等待批准 |
| NapCat | 反向 WebSocket；私聊和群聊白名单；`groupRequireMention` 控制是否必须 @。`src/main/channels/adapters/qq/napcat-adapter.ts:31-36` | 写指南；不把默认必须 @ 写成不可配置规则 |
| 官方 QQ 机器人 | 使用 openid 白名单，私聊可配置放行全部；接受多类群事件。`src/main/channels/adapters/qqbot/qqbot-adapter.ts:15-16,38-49` | 写明 openid 与 QQ 号不同，不笼统承诺群聊只接收 @ |
| 官方 QQ 出站 | 当前仅文本；本地实现私聊 60 分钟/4 次、群聊 5 分钟/5 次。`src/main/channels/adapters/qqbot/qqbot-adapter.ts:11-14,142-167` | 分开说明本地限制与平台发布时规则 |
| 官方 QQ 失败返回 | 明确返回“没有可引用的入站消息”“被动回复窗口已过”“回复次数已达上限”。`src/main/channels/adapters/qqbot/qqbot-adapter.ts:145-149` | 指南按这些返回解释排障 |
| 渠道工具策略 | QQ、QQ Bot 群聊强制 Chat；其他适用场景关闭工具为 Chat，开启工具为 Work，`allow_all`，不提供交互工具。`src/main/channels/agent-policy.ts:12-33` | 文档明确远程执行权限风险；1.2.0 收紧后同步更新（见全局约束） |
| 中文入口 | “连接手机”“保存并启动监听”“保存并连接”等已存在。`src/renderer/settings/i18n/zh-CN.json:30,661,676,694,697` | 直接使用现有中文文案 |

现有渠道功能不列入重新实现范围。

### 工程与 CI

- 生产依赖审计及报告上传已完成，保持非阻断。证据：`.github/workflows/test.yml` 的 `Audit production dependencies`、`Upload production dependency audit report`。
- 默认 Vitest 全集已接入 CI。实际配置是 `vitest.config.ts`（不是 `.mts`），列出七组测试路径；CI 无文件参数调用 `scripts/ci/run-vitest.ps1`，该脚本直接执行 `vitest run` 并传回退出码。证据：`vitest.config.ts` 的 `test.include`、`scripts/ci/run-vitest.ps1:1,15,23`、`.github/workflows/test.yml:99-103`。“把筛选测试改成默认 Vitest 全集”已不需要，不在施工范围。
- 默认 Vitest 不涵盖全部测试入口：现有 26 个 `scripts/**/*.test.mjs` 使用 Node 测试运行器；另有原生零写入独立验收配置。证据：`scripts/README.md:26`、`scripts/testing/vitest.memory-history-zero-write.config.ts`。
- CI 已执行部分 Rust 工作区测试及 SDK 示例测试，不代表所有原生测试都执行了。证据：`.github/workflows/test.yml:62-73`、`.github/workflows/plugin-sdk.yml:39-40`。
- 测试工作流只匹配 `main`、`firefly-demo` 的 push / PR；开发分支的直接 push 不会触发。证据：`.github/workflows/test.yml` 的 `on`。

## 全局约束

- 只读 1.2.0 新数据目录 `%APPDATA%\Firefly-1.2.0`；文档不引导读取、复制或迁移 1.1.x 数据。真机验收使用全新独立的测试数据目录。
- 示例中不出现真实凭据、本机私密路径或未经批准的联系信息。
- 来源声明依据 `LICENSE`、`MODEL_LICENSE.md`、`THIRD_PARTY_NOTICES.md` 和 README 核实，不把工程独立写成全部代码原创。不复制外部参考文档的联系人、承诺时限或素材授权结论。
- 平台配额、权限名称和发布步骤在发版前对照官方资料核对，记录核对日期；不写“零封号风险”之类的保证。
- 渠道 Work 模式的工具范围：插件 SDK 1.2.0 规格 §7.4 定为“默认 Chat，可按会话开 Work，只放行 `fs-read`”。收紧本身由渠道施工计划实现；本计划的指南先写当前行为，收紧合并后在同一施工包 B 的跟进 PR 里改文档（任务 B6）。
- 文档测试不新增“只检查固定段落文本”的测试；时间边界用假定时器并恢复；网络和模型用替身；文件行为用独立临时目录并清理；错误有稳定类型或代码时断言类型 / 代码及上下文，否则断言现有完整返回值。

## 文件清单

### 新建

- `docs/disclaimer.zh-CN.md`、`docs/disclaimer.en.md`
- `docs/user-guide/index.md`
- `docs/user-guide/feishu.md`、`docs/user-guide/napcat-onebot.md`、`docs/user-guide/qqbot-official.md`
- `docs/security/dependency-risk-register.md`
- `docs/engineering/test-coverage-map.md`

### 修改

- `README.md`、`README.en.md`：免责声明与用户指南入口。
- `electron-builder.yml`：安装包附带两份免责声明。
- `scripts/packaging/electron-builder-config.test.mjs`：覆盖上一条。
- `scripts/README.md`：依赖风险维护流程入口、各测试集合与可复现命令。
- `.github/workflows/test.yml`：补入 Node 脚本测试、有运行前提的独立验收入口；开发分支 push 触发。
- 渠道相关界面文案（施工包 E，按核对结果确定具体 i18n 键）。
- 仅在平台执行条件确实需要时调整既有测试 fixture（施工包 D）。

## 施工包

建议合并顺序：A → B → E → C → D。A、B、E 是用户文档线，C 是安全登记，D 是 CI；C、D 不依赖 A、B。

### 施工包 A：免责声明与导航

依赖：无
**改动文件：** `docs/disclaimer.zh-CN.md`、`docs/disclaimer.en.md`、`docs/user-guide/index.md`、`README.md`、`README.en.md`、`electron-builder.yml`、`scripts/packaging/electron-builder-config.test.mjs`

**任务：**

- [ ] A1 写中文免责声明 `docs/disclaimer.zh-CN.md`
  - 先写的测试：无自动化测试（文档）；人工验收见本包“验收”。
  - 实现：带修订日期和固定章节编号，覆盖：① 项目性质、角色来源与非官方关系；② MIT 代码许可和第三方素材许可边界；③ 用户对设备、账户、数据及生成内容的使用责任；④ 文件、命令、浏览器、扩展及持续授权风险；⑤ 本地存储、外部模型和其他服务的数据处理；⑥ AI 错误、专业判断和不可逆操作风险；⑦ 拟人化表达与情绪依赖边界；⑧ 未成年人使用条件（保留明确风险与使用限制，最终措辞由负责人审核）；⑨ 无担保与依法适用的责任边界；⑩ 条款说明不替代具体操作授权；⑪ 权利争议联系与处理方式（联系渠道待负责人提供，见“待负责人决定”；未提供前写 `【待负责人填写：私密联系渠道】`，不承诺处理期限）；⑫ 脱敏反馈方法；⑬ 来源、许可与贡献致谢。三种模式的风险说明按下表：

    | 场景 | 必须说明的行为 |
    |---|---|
    | 桌面 Chat | AI 输出、角色表达、本地与外部数据处理风险适用；具体能力服从已启用工具和授权 |
    | 桌面 Work | 补充文件修改、任务执行、外部服务和伙伴委派风险；不承诺所有操作必有弹窗 |
    | 桌面 Code | 补充命令执行、代码变更、工作区和备份风险 |
    | 渠道 Chat | 工具关闭时只聊天；QQ、QQ Bot 群聊强制采用该策略 |
    | 渠道 Work | 私聊开启工具后使用 Work；按当前实现工具直接执行，不能沿用桌面审批预期（1.2.0 收紧后改为只放行读取） |
    | 渠道 Code | 渠道策略不选择 Code；桌面切到 Code 或绑定上下文不等于远程获得 Code 权限 |

    依据：`README.md` 的三种模式章节、`src/main/channels/agent-policy.ts`、中文 i18n 的 `toolPermissionAllDesc`、`contextHint`。
  - 验证：人工通读；`git diff --check`
- [ ] A2 写英文免责声明 `docs/disclaimer.en.md`
  - 先写的测试：无自动化测试；人工逐条对照 A1。
  - 实现：与中文版相同的章节编号和修订日期，含义一致，不增加额外授权。
  - 验证：中英逐条对照；`git diff --check`
- [ ] A3 写用户指南首页 `docs/user-guide/index.md`
  - 先写的测试：无自动化测试。
  - 实现：渠道选择（飞书 / NapCat / 官方 QQ 各自适用场景）、公共的模式与权限说明（引用 A1 的三种模式表）、数据位置说明（不引导迁移 1.1.x）。
  - 验证：链接逐一点开可达
- [ ] A4 README 中英文加入口
  - 先写的测试：无自动化测试。
  - 实现：`README.md` 链到中文免责声明和用户指南，`README.en.md` 链到英文版。
  - 验证：点击链接到达正确语言和目标文件
- [ ] A5 安装包附带两份免责声明
  - 先写的测试：`scripts/packaging/electron-builder-config.test.mjs`：读取打包配置 → 断言 `docs/disclaimer.zh-CN.md` 与 `docs/disclaimer.en.md` 都在随包文件中，且没有把 `docs/` 整个目录打进包（只带这两个文件）。
  - 实现：`electron-builder.yml` 的 `extraResources`（或 `files`，按现有写法）加入两份文件。
  - 验证：`node --test scripts/packaging/electron-builder-config.test.mjs`；`npm run build:main`；打包后在安装目录里找到两份文件

**验收：**
- 中英文同一条款的风险、授权和数据处理含义一致，无额外授权。
- 点击 README 链接到达正确语言和目标文件。
- 示例中无真实凭据、本机私密路径或未经批准的联系信息。
- 数据目录说明不引导读取、复制或迁移 1.1.x 数据。
- 安装包里有两份免责声明。

**回退：** revert 本包提交即可；只有文档、链接和打包配置，无数据影响。

**工作量：** 1–1.5 人日

### 施工包 B：三份渠道指南

依赖：施工包 A（首页 `docs/user-guide/index.md`）
**改动文件：** `docs/user-guide/feishu.md`、`docs/user-guide/napcat-onebot.md`、`docs/user-guide/qqbot-official.md`；测试文件只在现有覆盖缺失时补充

三份指南统一包含：准备条件、平台配置、Firefly 配置、准入验证、消息与媒体能力、模式与权限、数据位置、排障、停用方法。先运行现有测试；下列场景已有覆盖则复用，缺失才在对应文件补充。

**任务：**

- [ ] B1 核对并补齐飞书准入与收发的测试
  - 先写的测试：`src/main/channels/adapters/feishu/sender-gate.test.ts`：未批准发送者 → 不进入消息处理、不下载媒体、不调用模型；批准后按既有契约处理。`src/main/channels/adapters/feishu/index.test.ts`：文本及受支持媒体 → 核对实际发送参数与结果；发送失败不得返回成功。
  - 实现：不改适配器；只补缺失的用例。
  - 验证：`npm test -- src/main/channels/adapters/feishu`
- [ ] B2 写飞书指南 `docs/user-guide/feishu.md`
  - 先写的测试：B1。
  - 实现：长连接、机器人能力、事件订阅、权限与发布；陌生发送者批准流程（默认 `allowAnyPrivate: false`、`allowedSenderIds: []`）。未经准入的消息不能描述成连接失败。
  - 验证：真机验收第 2、3 步（飞书部分）
- [ ] B3 核对并补齐 NapCat 准入与监听鉴权的测试
  - 先写的测试：`src/main/channels/adapters/qq/napcat-adapter.test.ts`：白名单内外 × 要求 @ 开关 × 消息含 / 不含 @ → 表驱动断言准入结果；拒绝不得进入后续处理。`src/main/channels/adapters/qq/onebot-listen-auth.test.ts`：本机与非本机监听、Token 缺失 / 错误 → 断言现有错误及连接拒绝，且没有消息分发。
  - 实现：不改适配器；只补缺失的用例。
  - 验证：`npm test -- src/main/channels/adapters/qq`
- [ ] B4 写 NapCat 指南 `docs/user-guide/napcat-onebot.md`
  - 先写的测试：B3。
  - 实现：Firefly 监听、NapCat 作为客户端连接；使用页面实际显示的 URL；区分本机、WSL、自定义监听与 Token 要求；白名单和 `groupRequireMention`。
  - 验证：真机验收第 2、3 步（NapCat 部分）
- [ ] B5 核对并补齐官方 QQ 与渠道策略的测试，写官方 QQ 指南 `docs/user-guide/qqbot-official.md`
  - 先写的测试：`src/main/channels/adapters/qqbot/qqbot-adapter.test.ts`：openid 准入、无入站消息、窗口边界及两侧（假定时器）、次数上限前后 → 断言完整结果；拒绝发送时 API 调用次数为零。`src/main/channels/agent-policy.test.ts`：三类渠道私聊、QQ 两类群聊、工具开关 → 比较完整策略对象；群聊不得暴露工具或转成 Work / Code。`src/main/channels/bootstrap.test.ts`：渠道消息进入运行时 → 核对实际模式、工具策略和生命周期；被拒绝的消息不得创建运行。
  - 实现：指南写 AppID / AppSecret、沙箱测试用户、openid 获取、白名单和“放行所有单聊”；仅文本出站、被动回复窗口与次数（本地限制：私聊 60 分钟 / 4 次、群聊 5 分钟 / 5 次）、主动投递限制；按适配器的三种失败返回解释排障。
  - 验证：`npm test -- src/main/channels/adapters/qqbot`；`npm test -- src/main/channels/agent-policy.test.ts src/main/channels/bootstrap.test.ts`；真机验收第 2、3 步（官方 QQ 部分）
- [ ] B6 渠道 Work 收紧合并后更新三份指南和免责声明的渠道 Work 一行（跟进 PR）
  - 先写的测试：沿用 B5 的 `agent-policy.test.ts`（由渠道施工计划改为只放行 `fs-read` 后的完整策略对象）。
  - 实现：把“工具直接执行”改为“只放行读取类工具，写入、命令等不可用；审批不能在外部平台完成”。
  - 验证：同 B5；真机验收第 4 步

**验收：** 三份指南与实际实现一致；真机验收第 2–6 步通过；单元测试与真实平台验收分别记录，不相互替代。

**回退：** revert 指南提交；补充的测试保留（它们描述现有行为）。

**工作量：** 1.5–2.5 人日

### 施工包 E：修正指南涉及的不准确界面提示

依赖：施工包 B（核对结果）
**改动文件：** B 过程中发现与实现不符的渠道界面文案（如群聊 @、记忆共享、平台安全描述）所在的 i18n 文件和组件，按核对结果确定

**任务：**

- [ ] E1 列出与实现不符的提示
  - 先写的测试：无（清单任务）。
  - 实现：在本计划进度文档里登记每条提示的位置、现在的说法、实际行为、证据。
  - 验证：负责人过目清单
- [ ] E2 逐条修正提示
  - 先写的测试：对应设置页组件的现有测试（如有）：渲染该设置项 → 断言新文案和它依据的配置值一致；没有组件测试的，补一个最小渲染用例。
  - 实现：只改文案，不改行为；行为确有缺陷的另开 Issue，不在本包修。
  - 验证：`npm run check:renderer`；在设置页实际查看每条提示

**验收：** 清单里每条提示都已修正或登记为独立缺陷；界面实际显示与指南一致。

**回退：** revert 本包；只涉及文案。

**工作量：** 0.5 人日（随核对结果浮动）

### 施工包 C：生产依赖风险登记

依赖：无
**改动文件：** `docs/security/dependency-risk-register.md`、`scripts/README.md`

**任务：**

- [ ] C1 建登记表 `docs/security/dependency-risk-register.md`
  - 先写的测试：无自动化测试（不新增机械检查文档字段的测试）；人工核验见本包“验收”。
  - 实现：Markdown 表格，每项记录：登记编号、审计日期、基线提交、锁文件摘要；包名、精确版本、公告编号、严重程度；直接 / 传递依赖、完整依赖链；安装包内实际位置或未入包证据；可控输入、调用入口、触发前提；修复版本、上游修复路径、兼容性影响；缓解措施、责任人、目标日期、复核日期；状态与关闭证据。状态流转：待核实 → 已确认 → 待修复 / 临时例外 → 待验证 → 已关闭；例外到期重新复核。
  - 验证：`git diff --check`
- [ ] C2 采集当前审计结果并逐项登记
  - 先写的测试：无自动化测试。
  - 实现：`npm audit --omit=dev --json` 的结果不直接等于安装包漏洞。入包判断同时查 `electron-builder.yml` 的 `files`、`asarUnpack`、`extraResources`、构建产物与分发目录；未知的标“待核实”。`package.json` 的 `overrides` 只作为现状记录，不证明漏洞已消除。高风险项在发版前全部给出结论；例外必须写责任人和到期日。
  - 验证：`npm audit --omit=dev --json`；`npm explain <实际登记的包名>`
- [ ] C3 `scripts/README.md` 加维护流程入口
  - 先写的测试：无。
  - 实现：说明何时重新采集、怎么判断入包、例外怎么续期。
  - 验证：链接可达

**验收：**
- 同一包存在多个版本或依赖链时分开列明受影响实例，不合并成单一结论。
- 未确认入包的保持“待核实”，不写成“不受影响”。
- 无上游修复的必须有缓解措施、责任人和复核期限。
- 审计服务失败时标记“采集失败”，不解释成零风险。

**回退：** revert；不改变运行时，无数据回滚需求。

**工作量：** 1–2 人日

### 施工包 D：CI 测试入口补齐

依赖：无
**改动文件：** `docs/engineering/test-coverage-map.md`、`.github/workflows/test.yml`、`scripts/README.md`；必要时个别测试 fixture

**任务：**

- [ ] D1 写测试覆盖清单 `docs/engineering/test-coverage-map.md`
  - 先写的测试：无自动化测试。
  - 实现：按“入口—测试集合—运行前提—CI 位置—证据”登记全部测试：默认 Vitest（保留现有入口）；Node 脚本测试（26 个现有文件）；独立零写入验收（专用配置及原生前提）；SDK 示例（复用现有工作流，核对触发范围）；Rust（核算现有命令覆盖范围及剩余测试的运行条件）。没有运行条件的测试显式记录原因和补跑入口。
  - 验证：确认当前 Node 24 对 `scripts/**/*.test.mjs` 的发现集合与清单一致，26 个现有文件均有执行归属
- [ ] D2 CI 补入 Node 脚本测试
  - 先写的测试：先跑现有的 `scripts/testing/run-tests.test.mjs`、`scripts/testing/archive-reporter.test.mjs`、`scripts/ci/trace-worker-process.test.mjs`、`scripts/ci/ci-timing.test.mjs`，确认通过。
  - 实现：`.github/workflows/test.yml` 增加执行 `node --test` 的步骤，覆盖全部 `scripts/**/*.test.mjs`。专用脚本若与全集重复，CI 里避免重复执行，但清单能定位归属。
  - 验证：`node --test scripts/testing/run-tests.test.mjs scripts/testing/archive-reporter.test.mjs scripts/ci/trace-worker-process.test.mjs scripts/ci/ci-timing.test.mjs`；在实施分支临时制造一个真实测试失败 → CI 必须失败并保留诊断；恢复后再跑一次通过。临时故障不进入合入提交
- [ ] D3 CI 补入有运行前提的独立验收
  - 先写的测试：独立验收缺原生 helper 时 → 不得记为通过，报告前置条件和实际未执行项。
  - 实现：在已构建 history / workspace helper 的步骤之后执行 `npm run test:memory-history-zero-write`；不把独立验收改名塞进默认集合。
  - 验证：`npm run build:history-helpers`；`npm run build:workspace-helper`；`npm run test:memory-history-zero-write`
- [ ] D4 开发分支的 push 也触发 CI
  - 先写的测试：无自动化测试。
  - 实现：`test.yml` 的 `on.push.branches` 加上 `dev/**`（`main`、`firefly-demo` 保留）。
  - 验证：推送一个开发分支，确认工作流被触发
- [ ] D5 新旧 CI 对比
  - 先写的测试：无。
  - 实现：确认默认 Vitest include、超时、worker 设置和审计非阻断策略保持不变；全量 CI 暴露的环境依赖只修 fixture 或补充明确前提，不扩大超时、不静默返回、不关闭测试。
  - 验证：对比改动前后的 `test.yml`；`git diff --check`

**验收：** 26 个 Node 脚本测试都在 CI 中执行；独立验收在有前提时执行、无前提时明确报告未执行；故意制造的失败能让 CI 失败；开发分支 push 能触发 CI；默认 Vitest 与审计策略不变。

**回退：** CI 新增入口可独立 revert，保留原有默认全集和诊断。

**工作量：** 1–2 人日

## 验收清单（全量）

- [ ] 施工包 A、B、E、C、D 全部合并，各包验收通过。
- [ ] 全集与工程检查通过：
  ```powershell
  npm test
  node --test scripts/**/*.test.mjs
  npm run test:eval
  npm run test:plugin-marketplace
  npm run test:plugin-examples
  npm run test:memory-history-zero-write
  npm run check:storage-boundary
  npm run check:plugin-schema
  npm run build:main
  npm run build:preload
  npm run check:renderer
  npm run build:renderer
  git diff --check
  ```
- [ ] Rust 现有入口通过（只代表已知原生入口，剩余入口按 D1 的清单补入）：
  ```powershell
  npm run build:history-helpers
  npm run build:workspace-helper
  cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --test workspace_handle_contract -- --test-threads=1
  cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --lib workspace_access -- --test-threads=1
  ```
- [ ] 真机验收（全新、独立的 1.2.0 测试数据目录，不启动旧数据目录）：
  1. 分别进入 Chat、Work、Code，确认指南描述的桌面权限行为。
  2. 按三份指南配置测试机器人，以允许和拒绝的身份发送消息。
  3. 飞书验证首次批准与媒体收发；NapCat 验证 URL、Token、白名单和 @ 配置；官方 QQ 验证 openid、文本回复及失败提示。
  4. 工具关闭时验证没有工具调用；开启工具时只使用临时目录和无害操作。
  5. 切换桌面模式、绑定上下文后，确认渠道权限没有被扩大。
  6. 停用渠道并重启，确认状态及配置恢复符合指南。
- [ ] 发版前对照官方资料复核平台规则，记录核对日期（0.5 人日）。

## 回滚方案

- 文档类施工包（A、B、E、C）按包 revert 链接或内容，无运行时影响。
- CI 施工包（D）的新增入口可独立回退，保留原有默认全集和诊断。
- 依赖登记不改变运行时，无数据回滚需求。

风险：
- **1.2.0 数据目录尚未落实**：是发布依赖，不能靠文档修复；新目录落地前不在正式目录做真机验收。
- **平台规则变化**：配额、权限名称、发布步骤发版前核对官方资料并记录日期。
- **界面提示可能过时**：由施工包 E 核对，不让新指南重复未经验证的承诺。
- **全量 CI 暴露环境依赖**：修 fixture 或补前提，不扩大超时、不静默返回、不关闭测试。
- **审计结果波动**：风险表固定提交、锁文件摘要与采集日期；例外有期限，不能永久沿用。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

已写入施工包的结论：安装包附带两种语言的免责声明（A5）；本期不做应用内强制同意，只提供文档入口；未成年人条款保留明确风险与使用限制，最终措辞由负责人审核（A1）；开发分支 push 触发 CI（D4）；依赖高风险项发版前逐项给出结论，例外须有负责人和到期日（C2）；修正文档直接涉及的不准确渠道提示，独立施工包并补界面验证（E）。

仍需负责人提供：

| 项 | 说明 |
|---|---|
| 私密权利争议联系渠道 | 免责声明第 ⑪ 条需要一个经批准的私密联系方式（如专用邮箱或表单）；不提供则保留“待填写”，不承诺处理期限 |
| 未成年人条款最终措辞 | A1 写出草稿后由负责人审核 |

## 工作量

| 施工包 | 估计 |
|---|---:|
| A：双语免责声明、导航、随包附带 | 1–1.5 人日 |
| B：三份渠道指南、现有测试核对与真机验收 | 1.5–2.5 人日 |
| E：修正不准确的界面提示 | 0.5 人日 |
| C：依赖风险采集、依赖链和入包登记 | 1–2 人日 |
| D：测试全集核算、CI 入口补齐与失败验证 | 1–2 人日 |
| 发布前平台资料复核与交叉检查 | 0.5 人日 |
| **合计** | **5.5–9 人日** |

不含依赖升级、1.2.0 数据目录实现、平台审批等待、首次同意机制，以及全量测试暴露的既有产品缺陷修复。
