# 页面与运行生命周期分离修复报告

状态：已完成主进程记忆修复及自动验证；浏览器与真机验收边界见下文
计划：[施工计划](run-lifecycle-fix.md)。设计来源为负责人本次任务。

## 结果与基线

已实现记忆运行授权与页面生命周期分离；浏览器 owner 本次未修改。
分支 `dev/run-lifecycle-fix`，HEAD `b4bcb2be847760f20b2bccf5f354655d99ffb70b`，起始工作树干净，最终分支/HEAD 不变。
没有执行 commit、checkout、reset、stash 或其他 git 写命令；没有更改依赖、CI、阈值或 ASR。

## 取消链路核实

1. `features/sessions/chat-ui-ipc.ts` 的 CHATS_SET_ACTIVE_SESSION 更新 Main target 后调用 onActiveTargetChanged；组合根 `app/default-dependencies.ts` 同步调用 ASR cancelAll、浏览器 binding.refresh、记忆 refresh。
2. 原 `memory/sources/main-desktop-session-authority.ts` 的全部 grant 都依赖 selected，refresh 在 A→B 时撤销 A；target registry 的主框架导航、WebContents destroyed 经 onInvalidated 撤销全部 grant。
3. 默认记忆 authorizeRun 把页面 signal 合入 admission；受控记忆直接返回页面 signal。
4. `features/chat/agui-bridge.ts` 监听授权 abort 后 cancelRun，转为 agent abort。
5. 浏览器 executor 在每次工具调用和 isCurrent 检查中取得 binding.getCurrentOwner；页面改变会撤销旧 owner，服务还检查原 host/mainFrame 存活和当前 owner 身份。只改 owner 的 refresh 无法保证生命周期独立。

其他撤销来源：会话删除、authority.dispose、memory.quiesce/close、默认记忆用户编辑/历史删除的 revokeAdmission、受控策略不再匹配、运行 release；模型设置变化经 refreshModels 和 MemoryRunAuthority 撤销实际模型运行；AGUI_CANCEL、接管、运行自身终态仍走原桥接逻辑。
origin 的 destroyed/navigation 还会释放 pending-turn 展示槽（pending-turn-lifecycle.release），没有取消运行；保持原样。ASR cancelAll 只取消听写，保持原样。

## 改动

- `main-desktop-session-authority.ts`：引入 page/run 两类私有 grant。bind、selected 保持页面规则；retainRun 只能从仍有效的页面 grant 创建独立运行 grant，run 不能再用于 promotion。refresh 对 run 检查会话存在、未删除、原模式与受控策略；页面 invalidation 只撤销 page。删除、dispose、releaseRun 仍撤销 run。
- `main-default-memory.ts`：页面准入后单独持有 run grant；保留引用计数和最后一次 release 的撤销。附件签发支持桥接传入的精确 Main handle（WeakMap 身份），无需再次依赖页面；复制、跨 admission 和已释放 handle 拒绝。不传 handle 的调用仍校验页面，并在异步准备完成后重检页面。已签发附件的使用只验证其运行及既有完整来源/元数据证明。
- `main-desktop-memory.ts`：受控准入持有独立 run grant；每次新的准入请求仍 bind 页面；最后 release 删除运行记录并撤销 signal。
- `agui-bridge.ts`：保存 authorizeRun 返回对象，仅在 Main 内传给附件准备；不从 renderer payload 接受授权句柄，授权 abort→cancelRun 保持不变。
- 四个既有测试文件新增统一 describe 分组；两个旧的“页面丢失应取消”用例调整为“release 应撤销”，保留释放及伪造信号拒绝的原有覆盖。
- 三层 AGENTS.md 仅补施工文件链接；新增本计划和验证报告，没有修改其他产品模块。

## 每个 require 调用点归类

以下为最终源码行号，authority 指 MainDesktopSessionAuthority。

| 文件/位置 | 类型 | 调用方与边界 |
| --- | --- | --- |
| main-default-memory.ts:224 requireAdmission | 运行 | openRun、召回、记录、afterTranscript、附件来源和运行入口检查；使用 admission.grant |
| main-default-memory.ts:918 checkIssuer | 页面 | 无 Main handle 的附件签发：初始及异步完成前重检 page |
| main-default-memory.ts:946 assertCurrent | 运行 | 附件读取、投影、后续访问；还验证同一 admission 和完整附件数据 |
| main-default-memory.ts:973 authorizeRun | 运行 | 先 bind 页面、再 retainRun 后检查新 run grant，不把 page.signal 作为运行 signal |
| main-default-memory.ts:1007、1013 appendUser | 页面 | 临时/持久会话的页面用户写入；拒绝时不执行 commit |
| main-default-memory.ts:1048、1058 mutate | 页面 | 临时/持久会话修改；沿用当前页面 bind 与提交前重检，不能取 admission 替代 |
| main-desktop-memory.ts:74 requireRun | 运行 | afterTranscript、S port、召回和历史访问 |
| main-desktop-memory.ts:90、92 authorizeRun | 运行 | 先 bind 页面，再检查已保留或刚创建的 run grant |
| main-desktop-memory.ts:101 appendUser | 页面 | 后端准备之后、metadata commit 之前重检 page |
| main-desktop-memory.ts:111 mutate | 页面 | 原当前目标页面的修改授权，保持原来的可操作范围 |
| main-desktop-memory.ts:128 port.run | 运行 | 每次执行受控 port 时按 run grant 校验与传递 signal |
| desktop-user-source-provider.ts:31 attachSession | 按 Main 调用方区分 | bind/appendUser 为页面；afterTranscript 与已准入的运行调整提交为运行 |
| desktop-user-source-provider.ts:53、54 commitUserEdit | 运行（两 runtime 的 afterTranscript） | 仅处理已提交 canonical edit，读前读后校验 run；独立模块显式传 page 时仍按 page 校验 |
| desktop-user-source-provider.ts:75 finishUserCommit | 按 ticket 来源区分 | 页面 append 的 ticket 是 page；默认运行 adjustment 的 ticket 是 run；绑定保留在 Main 私有 ticket 中 |

source.prepareUserCommit 通过 attachSession 的 require 使用传入的同一个 grant，没有把未知 token 或会话 ID 转成运行授权。

其他同名 require 保持原校验：

- main-default-memory.ts 的 runAuthority.require：298、321、349、353、488、522、529、537、628、697、702、762、963，全部是运行（桌面/临时/渠道/后台/子运行、模型档案和历史读取），不以页面作为 principal。
- settingsSource.require：803、805、811、812、815、817、818、830、831、857、873、881、886、895、896，全部是设置页面与精确 frame 的 IPC 操作，未改。
- sessionModes.require（506、520）和 actorAuthority.requireActor（243、360、366、703、714）为模式/actor 内部契约，不是页面或运行 grant 的替代入口，保持不变。

## 新增用例名称（31 个参数化实例）

统一位于 `describe("run lifetime is independent of the visible page", ...)`。

| 文件 | 用例名称模板 | 参数/实例数 |
| --- | --- | --- |
| main-desktop-session-authority.test.ts | `%s revokes the page grant but preserves the accepted run` | switch/navigation/destroyed，3 |
| 同上 | `%s still aborts a run after switching away` | delete/dispose/missing-session/policy-drift，4 |
| main-default-memory.test.ts | `a newly selected page needs fresh admission and only the final release ends the run` | 1 |
| 同上 | `accepted run issues its attachment after navigation using only its Main authorization` | 1 |
| 同上 | `%s preserves an issued attachment capability but denies new page issuance` | switch/navigation/destroyed，3 |
| 同上 | `%s preserves authorization and rejects page writes to the old session` | switch/navigation/destroyed，3 |
| 同上 | `%s aborts authorization after the page has gone` | delete/quiesce/close，3 |
| main-desktop-memory.test.ts | `a newly selected page needs fresh admission and only the final release ends the run` | 1 |
| 同上 | `profile mismatch after switching still revokes controlled admission` | 1 |
| 同上 | `%s preserves authorization and rejects page writes to the old session` | switch/navigation/destroyed，3 |
| 同上 | `%s aborts authorization after the page has gone` | delete/quiesce/close，3 |
| agui-bridge.test.ts | `%s keeps the run alive unless explicitly cancelled or deleted` | switch/navigation/destroyed/cancel/delete，5 |

桥接使用原 bridge() 夹具、真实 target registry 和真实受控记忆 authority；模型流为可预测替身。断言单个完整终态、运行 signal、是否仍活跃、成功 effects 与取消无 effects、Main handle 传递和释放。默认记忆实际通过 SQLite 与模型 fetch 替身完成 run.call。拒绝 page append 时断言 commit 未调用；附件 release 后断言不再调用读取器。

## 先失败与反向验证

- 改产品前：授权模块与两 runtime 新测试 19 失败（其中 authority 的 7 项缺少新 API；两 runtime 的 12 项实际观察到错误 abort）；修正桥接 fixture 后，旧产品上桥接 3 失败、显式取消/删除 2 通过。
- 追加发现的附件准备竞态：旧实现对导航后的精确 Main handle 抛 MEMORY_DESKTOP_SESSION_DENIED，1 失败；修复后通过。
- 逐次临时修改产品源码、运行新增 describe，确认测试失败后以保存的原始字节恢复，无 git 恢复操作；每次恢复都核对字节相等。

| 变异 | 被捕获的失败数 | 恢复 |
| --- | --- | --- |
| switch-revokes-run | 21 failed | 已恢复 |
| navigation-destroy-revokes-run | 19 failed | 已恢复 |
| delete-keeps-run | 3 failed | 已恢复 |
| dispose-keeps-run | 3 failed | 已恢复 |
| default-page-borrows-run | 7 failed | 已恢复 |
| controlled-page-borrows-run | 4 failed | 已恢复 |
| release-keeps-authority | 7 failed | 已恢复 |
| run-ignores-policy-and-session | 3 failed | 已恢复 |
| run-can-promote-again | 3 failed | 已恢复 |
| attachment-follows-page | 4 failed | 已恢复 |
| attachment-accepts-cloned-handle | 1 failed | 已恢复 |
| bridge-drops-run-handle | 5 failed | 已恢复 |
| default-final-release-keeps-admission | 7 failed | 已恢复 |
| controlled-final-release-keeps-admission | 8 failed | 已恢复 |
| page-token-revives-on-return | 3 failed | 已恢复 |

15 组全部被捕获，包括任务指定的四类（切换即撤销、删除不撤销、页面借用运行授权、dispose 不撤销）。这是定向契约变异，不是整仓 mutation coverage 百分比。

## 验证记录

2026-11-16，PowerShell：

```powershell
$env:NODE_OPTIONS="--no-experimental-webstorage"
npx vitest run src/main/memory src/main/agent/memory-runtime src/main/features/chat src/main/features/sessions src/main/platform src/main/app src/main/layering.test.ts
npx tsc -p tsconfig.main.json --noEmit
```

- 指定全量命令退出 0：**290 个文件通过、1 个文件跳过；4903 项通过、6 项跳过**，耗时 454.38 秒。layering.test.ts 的 3 项全部通过。
- 6 项均为既有跳过：5 项 non-Windows 专用测试在 Windows 下跳过（repository.test.ts 1 项、windows-platform-gates.test.ts 4 项）；workspace-file-editor.test.ts 的符号链接用例因进程缺少 Windows symlink 权限 EPERM 显式跳过。没有增加 skip 或降低阈值。
- 最终新增 describe 定向复跑退出 0：**31 通过**。233 skipped 来自 -t 过滤，不与全量命令中的 6 项环境跳过混淆。
- 主进程 tsc --noEmit 退出 0、无诊断。
- 附加测试类型核对：用项目现有 TypeScript Compiler API 把四个改动测试文件纳入检查，扩展 rootDir/DOM/JSX 以容纳原测试依赖；用只读 git show 的虚拟 CompilerHost 比对基线。基线 22 条、当前 22 条，新增诊断 0，新增 describe 范围诊断 0。原有诊断包括缺少 jsdom 声明、历史 fixture 缺 at、受控 backend fixture 的 transport 类型及 DOM/Node 类型混合；不宣称整个测试树类型检查通过。新增消息缺 at 的两处已修正，没有加抑制。
- git diff --check 退出 0；起止 HEAD/分支一致，没有凭据、本机配置、依赖/锁文件或 CI 修改。Git 对一个测试文件给出 LF→CRLF 的现有 autocrlf 提示，不是测试或 diff 检查失败。
- 验证归档：Vitest ArchiveReporter `2026-11-16T09-54-11-987Z-605b10c4-9288-4cc5-b1d1-c987dcabdd8e/report.json`。系统 TEMP 中有 firefly-lifetime-full.log、firefly-lifetime-final-focused.log、firefly-lifetime-tsc.log、firefly-lifetime-test-types.log 和 firefly-lifetime-mutations/results.json；没有把日志或本机路径作为产品数据提交。

没有执行打包或 Electron 真机/UI 验收，没有访问真实模型服务。

## 权限与风险

- 页面仍须通过原 host、top frame、活动 session、mode 和 rendererTargetId 校验。page token 没有变成跨页面凭证，旧 page 失效后切回也不能复活。
- run token 只能由有效 page 在 Main 创建；不同 session、未知对象不能取得既有运行授权。Main handle 不进入 IPC/模型/renderer，拷贝 handle 无效，释放后不能再签发附件。新页面如要发起操作必须重新 bind。
- 运行只保留已有 scope/actor/session 与附件证明，没有扩大历史可读范围、附件范围、模型许可或会话模式；受控策略漂移依旧撤销。
- **浏览器本次未修**：A→B/刷新仍可使正在用浏览器的运行失去 owner，工具调用可能返回 owner_mismatch/cancelled 或中断。需另行设计运行 owner 与页面面板 owner、guest 视图及宿主关闭的关系，不能宣称浏览器任务也实现完整连续运行。
- 自动测试不是 Electron 真机验证，没有刷新/关窗后的 UI 重连验收。主进程退出仍按原 quiesce/close 停止，不提供进程重启后的运行续跑。
- 当前技能中未找到 Superpowers；使用 context-engineering、constraint-driven-development、security-and-hardening、code-review-and-quality 与 differential-review 的适用检查，没有声称使用不可用技能，没有因技能停工或增加工具/阈值。

## 差异安全审查（differential-review）

基准为 b4bcb2b 到当前未提交工作树；产品 4 文件、测试 4 文件，另有施工文档和三层索引链接。授权变化按 HIGH 风险路径审查，不表示发现 HIGH 漏洞；当前大型仓库仅审本次路径和一跳依赖。

| 可复现发现严重程度 | 数量 |
| --- | --- |
| Critical / High / Medium / Low | 0 / 0 / 0 / 0 |

结论：未发现本次引入的权限扩大路径；建议负责人复核记忆修复，浏览器生命周期另行处理。不覆盖整仓安全或 Electron 真机行为。

- 历史：git blame 显示原 selected/check、全量 invalidation 和 admission 绑定来自 17b76f1b，当前文件的分层移动见 693590b。保留 selected 身份/模式校验；移除的 page-grant 相等比较由每次重新 bind 与 Main-only handle 身份校验替代。
- 影响面：authority 有 2 个生产构造调用方（默认/受控 runtime）；source provider 也有 2 个生产构造调用方；prepareAttachmentGrant 仅有 1 个生产调用点（agui-bridge），未登记为 renderer 直接 IPC。18 个 desktop authority.require 位置/语句已逐一分类。
- 攻击者模型：不可信 renderer 能提交会话 ID、frame/页面变化和序列化 payload，不能取得 Main 对象身份或 WeakMap 条目。
- 场景 A：A 有运行时切 B，再请求 appendUser(A)。原 bind/selected 拒绝，commit 未调用；页面借用 run grant 的变异被断言捕获。
- 场景 B：导航后返回 A，重用旧 page token 或把 run token 再作 promotion。旧 page 已 abort，retainRun 拒绝 run kind；切回不复活旧 token，两个反向变异均被捕获。
- 场景 C：复制授权对象给附件接口或 release 后继续使用。精确 WeakMap/admission 绑定拒绝；移除检查的变异被捕获。renderer 提供 authorization 字段也不会被采用，桥接参数只取 Main 的返回对象。
- 场景 D：页面离开后删除会话或关闭运行时。删除订阅/authority.dispose 同步撤销 run，相应变异被捕获。模型、记忆来源、附件元数据的其余边界测试保留。
- 没有移除测试、加入 skip、降低阈值、加 ts-ignore/eslint-disable、改权限档位、加入依赖或写入真实凭据。定向过滤不等于新增 skip。

## 整合与复核（2026-11-16）

- 分工：Codex 写主进程修复与各模块单元测试（上文）；Gemini 写验收测试 `src/main/features/chat/run-lifecycle.acceptance.test.ts`；克宝复核、整合、提交。
- 验收测试用真实的活动目标登记表、`chat-ui-ipc`、默认桌面记忆、会话授权、会话存储与 AG-UI 桥，只替换 electron 与模型。9 个场景：切到 B、刷新后再选 A、关窗、来回切换四种情况下 A 继续并以 success 结束；显式取消、删除 A、记忆运行时关闭三种情况下以 cancelled 结束；切换或刷新后，B 和刷新后的页面都不能借 A 的旧授权写 A 的用户内容或为 A 发起运行。在修复前的基线上前 4 个与后 2 个失败，修复后 9 项全部通过。
- 复核时的独立反向验证：
  - 页面失效时连运行授权一起撤销 → 验收测试的刷新、关窗、刷新后防复活 3 项失败；
  - 运行授权不再检查模式与受控策略 → 2 项失败；
  - 运行授权检查里去掉“会话已删除”判断 → 未失败：删除会话时 `onSessionDeleted` 已直接撤销该会话的全部授权，这是第二层，记录在此。
- 测试文件类型检查：四个改动测试文件修复前后同为 24 条既有诊断，未新增；验收测试文件 0 条。
- 提交按颗粒度拆分，每一步单独跑对应测试与主进程类型检查：授权模块 → 两个记忆运行时 → AG-UI 桥 → 验收测试 → 文档。
- 整合后全量验证：`npm test`（带 `FIREFLY_TEST_BASH`）1137 个文件、15011 项通过，11 项显式跳过，退出码 0；三端类型检查通过；`npm run build` 退出码 0。真机（Electron 中 A 运行时切到 B、刷新、关窗）未验。
