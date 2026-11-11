# Firefly-Agent 1.2.0 文档与工程施工计划

## 1. 目标

为用户提供中英文免责声明和三份渠道接入指南，准确解释 Firefly 的许可、角色素材来源、数据去向、AI 输出风险、工具授权及渠道限制。用户能够按照 Firefly 的中文界面完成配置，识别“连接成功但消息被拒”“工具关闭”“被动回复额度耗尽”等不同情况，并知道如何安全排障。

为维护者建立可追溯的生产依赖风险登记和测试入口清单，补齐默认 Vitest 集合以外的 CI 测试覆盖。保留现有审计非阻断策略、测试断言、超时及其他阈值，不引入检查工具。

本计划仅依据只读检查编制，未创建文件、修改代码、运行测试或构建。基线为 `c991111efa68087b9d625868179c03fea1b83e14`；工作树干净，实际为 detached HEAD，未检出用户指定的分支。后续实施前须重新核对提交与工作树。

## 2. 现状

### 2.1 文档与产品边界

- 已完整读取 `AGENTS.md`，后续遵守其中“修改与验证”和十二条测试断言要求。
- README 已说明模块职责：渠道位于 `src/main/channels/`，界面位于 `src/renderer/`，共享契约位于 `src/shared/`，启动隔离位于 `src/main/startup/`。证据：`README.md` 的“各层代码位置”“项目结构”。
- README 已有安全、权限、本地数据和外部服务说明；代码使用 MIT 许可，角色素材另有说明。证据：`README.md:115` 起、“许可证与角色素材”章节、`LICENSE:1`。这些内容应保留并链接完整条款，不重新编写许可。
- `git ls-files '*disclaimer*' 'docs/user-guide/*'` 无输出，当前缺少本任务要求的独立免责声明与渠道指南。
- 默认正式数据目录仍是 `%APPDATA%\Firefly`，尚未按版本隔离。证据：`src/main/startup/runtime-profile.ts:55-56`、`README.md`“数据位置”。因此，不能在新文档中声称当前实现已使用 1.2.0 新目录。

### 2.2 渠道实现

| 项目 | 当前实现与证据 | 本次处理 |
|---|---|---|
| 飞书 | 官方 SDK；只接受 `p2p`；调用 `admitSender`；支持多种媒体发送。`src/main/channels/adapters/feishu/index.ts:4,14,71,124,128` | 写指南；删除“无白名单”的旧假设 |
| 飞书默认准入 | `allowAnyPrivate: false`，`allowedSenderIds: []`。`src/main/channels/settings-store.ts:37` | 说明首次消息可能等待批准 |
| NapCat | 反向 WebSocket；私聊和群聊白名单；`groupRequireMention` 控制是否必须 @。`src/main/channels/adapters/qq/napcat-adapter.ts:31-36` | 写指南；不把默认必须 @ 写成不可配置规则 |
| 官方 QQ 机器人 | 使用 openid 白名单，私聊可配置放行全部；接受多类群事件。`src/main/channels/adapters/qqbot/qqbot-adapter.ts:15-16,38-49` | 写明 openid 与 QQ 号不同，不笼统承诺群聊只接收 @ |
| 官方 QQ 出站 | 当前仅文本；本地实现私聊 60 分钟/4 次、群聊 5 分钟/5 次。`src/main/channels/adapters/qqbot/qqbot-adapter.ts:11-14,142-167` | 分开说明本地限制与平台发布时规则 |
| 渠道工具策略 | QQ、QQ Bot 群聊强制 Chat；其他适用场景关闭工具为 Chat，开启工具为 Work，`allow_all`，不提供交互工具。`src/main/channels/agent-policy.ts:12-33` | 文档必须明确远程执行权限风险 |
| 中文入口 | “连接手机”“保存并启动监听”“保存并连接”等已存在。`src/renderer/settings/i18n/zh-CN.json:30,661,676,694,697` | 直接使用现有中文文案 |

现有渠道功能不列入重新实现范围。

### 2.3 工程与 CI

- 生产依赖审计及报告上传已经完成，保持非阻断。证据：`.github/workflows/test.yml` 的 `Audit production dependencies`、`Upload production dependency audit report`。
- 默认 Vitest 全集已接入 CI。实际配置是 `vitest.config.ts`，不是 `vitest.config.mts`。配置列出七组测试路径；CI 无文件参数调用 `scripts/ci/run-vitest.ps1`，该脚本直接执行 `vitest run`，并传回退出码。证据：`vitest.config.ts` 的 `test.include`、`scripts/ci/run-vitest.ps1:1,15,23`、`.github/workflows/test.yml:99-103`。**从施工范围删除“把筛选测试改成默认 Vitest 全集”。**
- 默认 Vitest 不涵盖全部测试入口：现有 26 个 `scripts/**/*.test.mjs` 使用 Node 测试运行器；另有原生零写入独立验收配置。证据：`scripts/README.md:26`、`scripts/testing/vitest.memory-history-zero-write.config.ts`。
- CI 已执行部分 Rust 工作区测试及 SDK 示例测试，不能据此宣称所有原生测试均已执行。证据：`.github/workflows/test.yml:62-73`、`.github/workflows/plugin-sdk.yml:39-40`。
- 测试工作流只匹配 `main`、`firefly-demo` 的 push/PR；不能假设对开发分支的直接 push 会触发。证据：`.github/workflows/test.yml` 的 `on`。

## 3. 设计

### 3.1 文档结构与免责声明

新增：

- `docs/disclaimer.zh-CN.md`
- `docs/disclaimer.en.md`
- `docs/user-guide/index.md`
- 三份渠道指南
- 生产依赖风险登记
- 测试入口覆盖清单

中英文条款使用相同章节编号和修订日期，覆盖：

1. 项目性质、角色来源与非官方关系。
2. MIT 代码许可和第三方素材许可边界。
3. 用户对设备、账户、数据及生成内容的使用责任。
4. 文件、命令、浏览器、扩展及持续授权风险。
5. 本地存储、外部模型和其他服务的数据处理。
6. AI 错误、专业判断和不可逆操作风险。
7. 拟人化表达与情绪依赖边界。
8. 未成年人使用条件。
9. 无担保与依法适用的责任边界。
10. 条款说明不替代具体操作授权。
11. 权利争议联系与处理方式。
12. 脱敏反馈方法。
13. 来源、许可与贡献致谢。

来源声明依据 `LICENSE`、`MODEL_LICENSE.md`、`THIRD_PARTY_NOTICES.md` 和 README 核实，不把工程独立写成全部代码原创。不复制外部参考文档的联系人、承诺时限或素材授权结论。

推荐采用仓库文档与 README 链接，不增加首次启动同意弹窗、持久化同意记录、IPC 或错误码。

### 3.2 三种模式的表现

| 场景 | 文档必须说明的行为 |
|---|---|
| 桌面 Chat | AI 输出、角色表达、本地与外部数据处理风险适用；具体能力服从已启用工具和授权 |
| 桌面 Work | 补充文件修改、任务执行、外部服务和伙伴委派风险；不能承诺所有操作必有弹窗 |
| 桌面 Code | 补充命令执行、代码变更、工作区和备份风险 |
| 渠道 Chat | 工具关闭时只聊天；QQ、QQ Bot 群聊强制采用该策略 |
| 渠道 Work | 适用私聊开启工具后使用 Work，工具直接执行，不能沿用桌面审批预期 |
| 渠道 Code | 当前渠道策略不选择 Code；桌面切到 Code 或绑定上下文不等于远程获得 Code 权限 |

依据：`README.md` 的三种模式章节、`src/main/channels/agent-policy.ts`、中文 i18n 的 `toolPermissionAllDesc`、`contextHint`。

### 3.3 渠道指南

三份指南统一包含：准备条件、平台配置、Firefly 配置、准入验证、消息与媒体能力、模式与权限、数据位置、排障、停用方法。

- **飞书**：说明长连接、机器人能力、事件订阅、权限与发布；明确陌生发送者批准流程。未经准入的消息不能被描述成连接失败。
- **NapCat**：说明 Firefly 监听、NapCat 作为客户端连接；使用页面实际显示的 URL；区分本机、WSL、自定义监听与 Token 要求；说明白名单和 `groupRequireMention`。
- **官方 QQ**：说明 AppID/AppSecret、沙箱测试用户、openid 获取、白名单和“放行所有单聊”；明确仅文本出站、被动回复窗口与次数、主动投递限制。

既有状态沿用 `ChannelStatus`，既有失败沿用返回值，不新造产品错误码。例如官方 QQ 当前明确返回“没有可引用的入站消息”“被动回复窗口已过”“回复次数已达上限”。证据：`src/main/channels/adapters/qqbot/qqbot-adapter.ts:145-149`。

指南解释现有配置与查询链路：`IPC.CHANNELS_GET_CONFIG`、`CHANNELS_SAVE_CONFIG`、`CHANNELS_GET_STATUS`、`CHANNELS_SENDER_RESOLVE`、`CHANNELS_QQ_TEST_CONNECTION`、`CHANNELS_QQBOT_TEST_CONNECTION`。证据：`src/main/channels/init.ts:71-109`。本次不修改这些接口。

### 3.4 生产依赖风险登记

使用 Markdown 表格，不增加运行时数据结构。每项记录：

- 登记编号、审计日期、基线提交、锁文件摘要。
- 包名、精确版本、公告编号、严重程度。
- 直接/传递依赖、完整依赖链。
- 安装包内实际位置或未入包证据。
- 可控输入、调用入口、触发前提。
- 修复版本、上游修复路径、兼容性影响。
- 缓解措施、责任人、目标日期、复核日期。
- 状态与关闭证据。

状态：待核实 → 已确认 → 待修复/临时例外 → 待验证 → 已关闭；例外到期重新复核。

`npm audit --omit=dev` 结果不直接等于安装包漏洞。入包判断同时查 `electron-builder.yml`、构建产物与分发目录；未知标“待核实”。现有 overrides 仅作为现状记录，不证明漏洞已经消除。依据：`package.json` 的 `dependencies`、`overrides`，以及 `electron-builder.yml` 的 `files`、`asarUnpack`、`extraResources`。

本主题不执行依赖升级、不改锁文件、不运行自动修复。实际升级按风险登记拆成独立任务。

### 3.5 CI 测试覆盖

以“入口—测试集合—运行前提—CI 位置—证据”登记测试全集：

- 默认 Vitest：保留现有入口。
- Node 脚本测试：补齐 26 个现有文件的 CI 执行。
- 独立零写入验收：单列专用配置及原生前提。
- SDK 示例：复用现有工作流，核对触发范围。
- Rust：核算现有命令覆盖范围及剩余测试的运行条件。

不把独立验收改名塞进默认集合。没有运行条件的测试必须显式记录原因和补跑入口；不能静默跳过后宣称全量通过。

## 4. 改动清单

### 步骤 A：免责声明与导航

- 新增两份免责声明。
- 修改 `README.md`、`README.en.md`：增加对应语言链接和指南入口。
- 新增 `docs/user-guide/index.md`：渠道选择、公共权限与模式说明。

不改运行时、许可文件和打包配置。安装包离线附带条款列入待决定项。

### 步骤 B：三份渠道指南

新增：

- `docs/user-guide/feishu.md`
- `docs/user-guide/napcat-onebot.md`
- `docs/user-guide/qqbot-official.md`

按实际实现编写，不修改适配器。发现文档与实现不符时，先纠正文档；实际缺陷另建修复范围。

### 步骤 C：依赖风险基线

- 新增 `docs/security/dependency-risk-register.md`。
- 记录当次审计、依赖链、入包证据与例外模板。
- 在 `scripts/README.md` 增加维护流程入口。

### 步骤 D：CI 入口补齐

- 新增 `docs/engineering/test-coverage-map.md`。
- 修改 `.github/workflows/test.yml`：补入 Node 脚本测试和具备运行前提的独立验收入口。
- 修改 `scripts/README.md`：说明各测试集合和可复现命令。
- 仅在平台执行条件确实需要时调整既有测试 fixture；不得降低断言、阈值或删除用例。

每步独立合入；D 不依赖免责声明和渠道文档。

## 5. 测试

### 步骤 A

文档人工验收，不新增只检查固定段落文本的测试：

- 中英文同一条款 → 风险、授权和数据处理含义一致，无额外授权。
- 点击 README 链接 → 到达正确语言和目标文件。
- 检查示例 → 无真实凭据、本机私密路径或未经批准的联系信息。
- 阅读数据目录说明 → 不引导读取、复制或迁移 1.1.x 数据。

### 步骤 B

先运行现有测试；以下场景已有覆盖则复用，缺失时才在对应文件补充：

| 测试文件 | 输入条件 → 断言 |
|---|---|
| `src/main/channels/adapters/feishu/sender-gate.test.ts` | 未批准发送者 → 不进入消息处理、不下载媒体、不调用模型；批准后按既有契约处理 |
| `src/main/channels/adapters/feishu/index.test.ts` | 文本及受支持媒体 → 核对实际发送参数与结果；发送失败不得返回成功 |
| `src/main/channels/adapters/qq/napcat-adapter.test.ts` | 白名单内外、要求 @ 开关、消息含/不含 @ → 表驱动断言准入结果；拒绝不得进入后续处理 |
| `src/main/channels/adapters/qq/onebot-listen-auth.test.ts` | 本机与非本机监听、Token 缺失/错误 → 断言现有错误及连接拒绝，无消息分发 |
| `src/main/channels/adapters/qqbot/qqbot-adapter.test.ts` | openid 准入、无入站消息、窗口边界及两侧、次数上限前后 → 断言完整结果；拒绝发送时 API 调用为零 |
| `src/main/channels/agent-policy.test.ts` | 三类渠道私聊、QQ 两类群聊、工具开关 → 比较完整策略对象；群聊不得暴露工具或转成 Work/Code |
| `src/main/channels/bootstrap.test.ts` | 渠道消息进入运行时 → 核对实际模式、工具策略和生命周期；拒绝不得创建运行 |

时间边界使用假定时器并恢复；网络和模型用替身；文件行为使用独立临时目录并清理。错误已有稳定类型或代码时断言类型/代码及上下文，否则断言现有完整返回值。

### 步骤 C

人工核验风险表：

- 同一包存在多个版本或依赖链 → 分开列明受影响实例，不合并成单一结论。
- 未确认入包 → 保持待核实，不写成“不受影响”。
- 无上游修复 → 必须有缓解措施、责任人和复核期限。
- 审计服务失败 → 标记采集失败，不解释成零风险。

不新增漏洞扫描器或机械检查文档字段的测试。

### 步骤 D

- 执行现有 `scripts/testing/run-tests.test.mjs`、`scripts/testing/archive-reporter.test.mjs`、`scripts/ci/trace-worker-process.test.mjs`、`scripts/ci/ci-timing.test.mjs`。
- 在实施分支临时制造一个真实测试失败 → CI 必须失败并保留诊断；恢复后再次运行。临时故障不得进入合入提交。
- 核对发现的 Node 测试文件集合 → 26 个现有文件均有执行归属，新增文件能随所选入口被发现。
- 独立验收缺原生 helper → 不得记为通过；报告前置条件和实际未执行项。
- 新旧 CI 对比 → 默认 Vitest include、超时、worker 设置和审计非阻断策略保持不变。

## 6. 验证命令

以下命令用于后续实施；本次只读规划未执行。

### 最近测试

```powershell
npm test -- src/main/channels/agent-policy.test.ts src/main/channels/bootstrap.test.ts
npm test -- src/main/channels/adapters/feishu
npm test -- src/main/channels/adapters/qq
npm test -- src/main/channels/adapters/qqbot
node --test scripts/testing/run-tests.test.mjs scripts/testing/archive-reporter.test.mjs scripts/ci/trace-worker-process.test.mjs scripts/ci/ci-timing.test.mjs
```

### 全集与工程检查

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

实施时先确认当前 Node 24 对脚本 glob 的发现集合与登记表一致；不得只凭命令退出成功判断文件已全部执行。专用脚本可能与全集重复，CI 可避免重复执行，但覆盖清单必须能定位其归属。

Rust 前提与现有命令：

```powershell
npm run build:history-helpers
npm run build:workspace-helper
cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --test workspace_handle_contract -- --test-threads=1
cargo test --locked --manifest-path native/Cargo.toml --features workspace-handle --lib workspace_access -- --test-threads=1
```

以上只代表当前已知原生入口，不代表全部 Rust 测试。剩余入口在步骤 D 核算后补入覆盖清单。

依赖采集：

```powershell
npm audit --omit=dev --json
npm explain <实际登记的包名>
```

### 真机验收

使用全新、独立的 1.2.0 测试数据目录，不启动旧数据目录：

1. 分别进入 Chat、Work、Code，确认指南描述的桌面权限行为。
2. 按三份指南配置测试机器人，以允许和拒绝的身份发送消息。
3. 飞书验证首次批准与媒体收发；NapCat 验证 URL、Token、白名单和 @ 配置；官方 QQ 验证 openid、文本回复及失败提示。
4. 工具关闭时验证没有工具调用；开启工具仅使用临时目录和无害操作。
5. 切换桌面模式、绑定上下文后，确认渠道权限没有被扩大。
6. 停用渠道并重启，确认状态及配置恢复符合指南。

真实平台验收与单元测试分别记录，不相互替代。

## 7. 风险与回退

- **1.2.0 数据目录尚未落实**：这是发布依赖，不能靠文档修复。新目录方案完成前，不在正式目录进行真机验收。
- **平台规则变化**：指南中配额、权限名称、发布步骤在发版前核对官方资料，记录核对日期；不写“零封号风险”等保证。
- **界面提示可能过时**：例如群聊 @、记忆共享和平台安全描述，应核对后登记独立修复，不让新指南重复未经验证的承诺。
- **全量 CI 暴露环境依赖**：修复 fixture 或补充明确前提，不扩大超时、不静默返回、不关闭测试。
- **审计结果波动**：风险表固定提交、锁文件摘要与采集日期；例外有期限，不能永久沿用。
- **回退**：文档按独立步骤撤回链接或内容；CI 新增入口可独立回退，保留原有默认全集和诊断。依赖登记不改变运行时，无数据回滚需求。

## 8. 待负责人决定

| 决策 | 推荐选项 |
|---|---|
| 1.2.0 正式新数据目录的名称及落地任务归属 | 由启动隔离任务统一确定；本计划只引用最终契约，禁止迁移旧数据 |
| 是否要求安装包离线附带免责声明 | 推荐附带两种语言文件；批准后另加打包配置与 `scripts/packaging/electron-builder-config.test.mjs` 验证 |
| 是否增加应用内强制同意 | 本期仅文档入口；强制同意涉及状态、IPC 和界面，另行设计 |
| 未成年人条款及责任边界 | 保留明确风险与使用限制，由负责人审核最终措辞，不复制外部条款结论 |
| 私密权利争议联系渠道及响应期限 | 提供经批准的私密渠道；不凭空填写邮箱或承诺处理期限 |
| 开发分支直接 push 是否触发 CI | 推荐覆盖开发分支；当前只覆盖既有分支，触发策略变更需单列确认 |
| 依赖风险责任人与期限 | 发版前完成高风险逐项结论；例外必须指定负责人及到期日 |
| 现有不准确渠道提示是否本期修正 | 推荐修正文档直接涉及的提示，独立提交并补对应界面验证 |

## 9. 工作量

| 步骤 | 估计 |
|---|---:|
| A：双语免责声明、导航与条款核对 | 1—1.5 人日 |
| B：三份渠道指南、现有测试核对与真机验收 | 1.5—2.5 人日 |
| C：当前依赖风险采集、依赖链和入包登记 | 1—2 人日 |
| D：测试全集核算、CI 入口补齐与失败验证 | 1—2 人日 |
| 发布前平台资料复核与交叉检查 | 0.5 人日 |
| **合计** | **5—8.5 人日** |

不含依赖升级、1.2.0 数据目录实现、平台审批等待、首次同意机制，以及全量测试暴露的既有产品缺陷修复。