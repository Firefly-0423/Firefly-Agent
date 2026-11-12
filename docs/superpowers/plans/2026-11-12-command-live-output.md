# 命令实时输出施工计划

状态：待施工
规格：无独立规格；依据外部参考文档盘点条目与负责人 2026-11-12 的决定（权限档位见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2）。

**目标：** 在适用模式中执行前台 `run_shell` 时，用户无需等待命令结束，就能在对应工具卡片中看到命令和持续增加的输出。命令结束、失败、取消或超时后，保留已有输出、真实状态和必要的错误信息；重新打开会话后，可以查看、复制最近保存的输出。输出面板最多保存最近 64,000 个 Unicode 码点，明确提示可见窗口截断和底层捕获截断。Windows 输出在结束时按现有编码判定重新解码，替换实时预览。

| 模式 | 计划表现 |
|---|---|
| Chat | 保持当前工具范围，不新增命令执行权限；共用展示组件能安全展示本会话已有的合法记录。 |
| Work | 主流程前台命令实时显示；伙伴前台命令显示在对应委派任务内，分别保存。 |
| Code | 与 Work 使用相同输出能力；聊天工具卡片和右侧运行结果采用同一输出组件。 |
| 后台命令 | 继续使用 `run_in_background`、`shell_job`；不把后台日志接入本面板。 |

**架构：** 实现完全放在 Firefly 自己的执行、事件、会话和界面模块中。新增 `src/shared/command-output.ts` 统一主进程、渲染端和持久化边界（64,000 个 Unicode 码点有界尾窗）。在 `ToolContext` 增加可选 `onCommandOutput`，由 `harness/tool-dispatcher.ts` 在单次前台 `run_shell` 调用中注入真实 `call.id` 与递增 `sequence`。`run-shell-tool.ts` 对 stdout/stderr 分别使用增量 UTF-8 解码器、按每 100 毫秒批处理发布 `command_output` 事件（映射为 AG-UI `CUSTOM firefly.command.output`），结束时按每流完整捕获字节确定编码（先严格 UTF-8，失败尝试 GBK，再宽松回退）并发送最终 `replace`。渲染端 `AgentRunController.ts` 校验归属后更新 `ToolExecutionRecord.commandOutput`，以“首次变脏后最多 350 毫秒写入一次”的有界检查点经 `chats-store.ts` 落盘。Work / Code 的伙伴前台命令由 `child-session-runtime.ts` 按 `(childRunId, toolCallId)` 收集有界记录，经 Main 窄回调发送 `firefly.task.command_output` 归属到父委派卡片，并随 `TaskSession` 与 `ToolTaskResult` 保存。聊天卡片与右侧运行结果共用 `CommandOutputPanel.tsx`。

**不改的东西：**
- 本计划不包含交互式终端、PTY、终端输入或终端标签页。
- Chat 保持当前工具范围，不新增命令执行权限；后台命令继续使用 `run_in_background`、`shell_job`，从实时面板接入范围排除。
- 原始捕获继续遵守 `SHELL_CAPTURE_LIMIT_PER_STREAM`（每流 2 MiB），不重新实现捕获限额，不扩大最终工具结果 `result`；保留最终 JSON、stdout/stderr 顺序、错误码（`E_SHELL_EXIT`、`E_SHELL_SPAWN`、`E_TOOL_TIMEOUT`、`E_ABORTED` 等）、重试和副作用判定。
- 不改变 `ToolExecutionRecord.status: "running" | "success" | "error"`，不扩大所有工具的状态枚举。
- 不新增 IPC 通道（沿用 `src/shared/ipc-channels.ts:17–20` 的 `agui:run`、`agui:event`、取消和保存确认）。
- 输出事件只改变命令展示记录，不进入模型消息、S/M/H 记忆、执行账本或副作用证据。
- 不修改会话 schema 版本，不添加旧数据迁移器；不为本功能修改 `conversation-transcript-types.ts` 或 `conversation-transcript-store.ts`。
- `package.json:201` 的版本仍为 `1.1.4`。本功能不顺带调整发布版本号，由 1.2.0 发布工作统一处理。
- 已有权限、安全策略、后台作业、最终工具结果存储和进程树清理，不列为重新建设内容。

## 现状

### 核对基线

- 实际 HEAD 为 `c991111efa68087b9d625868179c03fea1b83e14`，工作树干净。
- 当前工作目录处于 detached HEAD；本地存在 `dev/firefly-1.2.0` 分支，但不能将当前检出状态描述为位于该分支。
- 已完整读取 `AGENTS.md`，按“修改与验证”“测试断言写法”安排施工和验证。
- 模块职责以 `README.md:213–218` 为依据：执行属于工具模块，编排属于 Harness，界面属于 React，跨进程通信经过 preload。
- `package.json:201` 的版本仍为 `1.1.4`。本功能不顺带调整发布版本号，由 1.2.0 发布工作统一处理。

### 已有能力与缺口

| 项目 | 当前实现及证据 | 施工结论 |
|---|---|---|
| 命令捕获 | `src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts` 的 `executePlan`、`capture`、`buildResult` 收集 stdout/stderr，完成后返回结果。 | 复用捕获入口，新增观察回调。 |
| 编码处理 | 同文件 `decodeShellOutput` 先严格 UTF-8，失败后尝试 GBK，再宽松回退。 | 保留判定规则，补实时增量解码和结束校正。 |
| 捕获边界 | 同文件 `SHELL_CAPTURE_LIMIT_PER_STREAM` 为每流 2 MiB；`captureTruncated` 已进入结果。 | 不重新实现捕获限额，不扩大最终结果。 |
| 超时、取消与清理 | 同文件 `resolveTimeoutPolicy`、`terminate`、`retainShellCompletion` 已处理超时、进程树终止和实际完成保留。 | 保留契约，补观察事件收尾。 |
| 模式范围 | 同文件 `runShellTool.modes` 为 `code`、`work`；`src/main/orchestrator/tools/registry/tool-registry.ts:107` 按模式过滤工具。 | Chat 不新增执行能力。 |
| 后台执行 | `executeRunShell` 的后台分支调用 `startShellJob`，返回 `jobId`、`logFile`。 | 从实时面板接入范围排除。 |
| 单次调用上下文 | `src/main/orchestrator/tools/registry/tool-context.ts` 的 `createToolInvocationContext` 隔离调用上下文；`harness/tool-dispatcher.ts:135–142` 创建上下文并发布开始事件。 | 在这里绑定真实 `call.id`，不得从命令参数取身份。 |
| 事件链 | `harness/types.ts:55–56` 有工具开始、结束事件；`harness/adapter/event-mapper.ts` 的 `sendHarnessEventAsAgui` 已映射 AG-UI。 | 复用链路，新增命令输出事件。 |
| IPC | `src/shared/ipc-channels.ts:17–20` 已有 `agui:run`、`agui:event`、取消和保存确认；`src/preload/index.ts:213–224` 已转发事件并提供解除监听。 | 不新增 IPC 通道。 |
| 输出链缺失 | 本次 `git grep -n -E 'tool_output\|onShellOutput\|terminalOutput\|CommandTerminal' -- src` 无匹配；相关源码中也未发现命令增量事件处理。 | 实时输出链仍需施工。 |
| 工具记录 | `src/shared/chat-types.ts:24` 的 `ToolExecutionRecord` 有参数、结果、状态，没有命令输出快照。 | 新增可选字段。 |
| 结果预览 | `harness/tool-round.ts` 的结束事件把预览限制为 200 字符；`AgentRunController.ts:689–696` 又把收到的结果限制为 4,000 字符。 | 不能用现有 `result` 充当命令日志。 |
| 保存入口 | `AgentRunController.ts` 的 `buildCheckpoint` 将工具记录交给 `store.upsert`；`src/main/chats/chats-store.ts` 的 `upsertMessage`、`writeJson` 保存聊天消息。 | 在聊天存储边界限制新字段，不按旧盘点修改 transcript 校验。 |
| 检查点时机 | `AgentRunController.ts` 的 `checkpointRun` 每次重新设置 350 毫秒定时器。 | 持续输出可能一直推迟保存，需为命令输出补最大等待边界。 |
| 工具卡片 | `ChatMessageList.tsx` 的 `toolChainItem` 只有 `result` 或 `changes` 时才生成内容区。 | 运行中无最终结果也必须能显示面板。 |
| 右侧结果 | `workspace/WorkspaceRunResults.tsx` 的 `ToolFold` 用 `<pre>` 展示 `tool.result`。 | Work / Code 右侧同步复用命令面板。 |
| 伙伴输出 | `child-session-runtime.ts` 的 `onEvent` 目前只投影为任务轨迹；`task-events.ts` 的 `tool_start`、`tool_end` 不保存命令输出。 | 伙伴命令不能直接复用父工具 ID，需独立接入。 |
| 子任务结果校验 | `src/shared/task-result-evidence.ts` 的 `normalizeToolTaskResult` 白名单返回结果字段。 | 新增伙伴输出字段时必须同步更新校验。 |
| 取消后的事件 | `src/main/orchestrator/harness-adapter.ts:44` 在 `signal.aborted` 后停止转发 Harness 事件。 | 直接新增事件会丢失取消后的校正，需要限定范围的收尾通路。 |
| 复制与 ANSI | `components/CopyButton.tsx` 已有 `copyTextToClipboard`；本次搜索未找到可复用的 ANSI 输出展示组件，`package.json` 未声明相关直接依赖。 | 复用复制能力，ANSI 单独封装。 |
| 数据隔离 | `src/main/startup/runtime-profile.ts` 的 `resolveRuntimeProfile` 已提供开发、测试和 smoke 隔离，但 production 仍使用 `%APPDATA%\Firefly`。 | 1.2.0 正式目录隔离尚未满足，列为上线前置步骤。 |

仓库现有计划目录中，本次关键词检索未发现本功能的专门施工计划；本轮没有运行测试或构建，不能声称当前基线已经通过这些检查。

## 全局约束

- **1.2.0 正式数据目录与持久化边界**：正式数据目录定为 `%APPDATA%\Firefly-1.2.0`（负责人 2026-11-12 决定），仅兼容 **1.2.0 新目录内部**缺少 `commandOutput` 可选字段的记录；不得扫描、读取或迁移 1.1.x 历史。随会话保存有界输出，继承会话删除行为；不增加遥测、搜索索引或模型上下文；明确输出可能包含命令自身打印的敏感内容。首版保证恢复最近成功检查点，不承诺窗口关闭或应用崩溃零丢失。
- **权限档位与模式边界**：用户可选的权限档位只有三档（只读 `read-only`、请求审批 `per-action`、完全访问 `full`），1.2.0 删除旧值 `project-read-only` 和 `scoped`（见 `docs/superpowers/specs/2026-11-12-plugin-sdk-1-2-0.md` §7.2）。Chat 不新增命令执行能力；实时展示沿用 Work / Code 当前权限范围；审批拒绝、计划只读、沙箱拒绝时无 spawn、无原始输出事件、无输出日志文件。
- **捕获边界与字符计数语义**：保持每流 2 MiB（`SHELL_CAPTURE_LIMIT_PER_STREAM`）捕获契约，默认保留“现有已捕获数据中的最近 64,000 个 Unicode 码点”（避免截断 emoji 的代理对，产品文案继续称“字符”）。某条流达到 2 MiB 后，更晚且未被捕获的内容不会出现在面板；必须显示捕获截断提示。
- **ANSI 渲染与安全边界**：允许增加一项专用运行依赖（推荐评估 `ansi-to-react`：[官方说明](https://github.com/nteract/ansi-to-react)），具体版本、React 19 兼容性和控制序列行为需在接入时验证并锁定，不能直接照搬外部参考文档的版本。仅呈现颜色和文本；不使用原始 HTML，不自动打开链接，不执行 OSC 剪贴板或终端控制动作。复制得到去除控制序列后的可见文本。颜色样式跨尾窗截断时允许重置，不能出现裸控制码或破坏正文。
- **测试断言与验证要求（`AGENTS.md` 12 条）**：稳定契约比较完整对象或有序事件列表；错误断言代码、类别和必要上下文；拒绝、失败与取消同时验证不该发生的执行、写入和泄露。时间用假定时器，结束后恢复；文件系统用独立临时目录和真实文件；平台依赖缺失显式跳过并说明原因。不新增检查工具、不降低断言或阈值、不修改 CI 策略。所有命令只在 Firefly 工作树执行，不把外部参考文档目录加入测试、构建或运行路径。

## 文件清单

### 新建

- `src/shared/command-output.ts`、`src/shared/command-output.test.ts`
- `src/main/orchestrator/tools/builtin-tools/command-output-capture.ts`、`src/main/orchestrator/tools/builtin-tools/command-output-capture.test.ts`
- `src/main/orchestrator/harness/tool-dispatcher-command-output.test.ts`
- `src/renderer/react/features/chat/components/CommandOutputPanel.tsx`、`src/renderer/react/features/chat/components/CommandOutputPanel.css`、`src/renderer/react/features/chat/components/CommandOutputPanel.test.tsx`
- `src/renderer/react/features/chat/components/command-output-presentation.ts`、`src/renderer/react/features/chat/components/command-output-presentation.test.ts`
- `src/main/orchestrator/command-output.integration.test.ts`

### 修改

- `src/main/startup/runtime-profile.ts`、`src/main/startup/runtime-profile.test.ts`、`src/main/startup/runtime-profile-documentation.test.ts`、`README.md`
- `src/shared/chat-types.ts`、`src/shared/task-session.ts`、`src/shared/task-result-evidence.ts`、`src/shared/task-result-evidence.test.ts`
- `src/main/orchestrator/tools/registry/tool-context.ts`
- `src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts`、`src/main/orchestrator/tools/builtin-tools/run-shell-outcomes.test.ts`、`src/main/orchestrator/tools/builtin-tools/run-shell-capture-limit.test.ts`
- `src/main/orchestrator/harness/tool-dispatcher.ts`、`src/main/orchestrator/harness/types.ts`、`src/main/orchestrator/harness/adapter/event-mapper.ts`、`src/main/orchestrator/harness/adapter/event-mapper.test.ts`、`src/main/orchestrator/harness/adapter/tool-runtime.ts`、`src/main/orchestrator/harness/builtin-tools.ts`
- `src/main/orchestrator/harness-adapter.ts`、`src/main/orchestrator/harness-adapter.test.ts`
- `src/main/orchestrator/child-session-types.ts`、`src/main/orchestrator/child-session-runtime.ts`、`src/main/orchestrator/persistent-agent-runtime.ts`、`src/main/orchestrator/persistent-agent-runtime.test.ts`
- `src/main/chats/chats-store.ts`、`src/main/chats/chats-store.test.ts`
- `src/main/chat/agui-bridge.test.ts`
- `src/main/tasks/task-session-store.ts`、`src/main/tasks/task-session-store.test.ts`、`src/main/tasks/task-session-runtime-store.test.ts`
- `src/renderer/react/features/chat/pages/run/AgentRunController.ts`、`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`
- `src/renderer/react/features/chat/pages/run-event-gate.test.ts`
- `src/renderer/react/features/chat/components/ChatMessageList.tsx` 及相关测试
- `src/renderer/react/features/chat/workspace/WorkspaceRunResults.tsx`、`src/renderer/react/features/chat/workspace/WorkspaceRunResults.test.ts`
- `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`
- `package.json`、`package-lock.json`、`THIRD_PARTY_NOTICES.md`

## 施工包

建议合并顺序：施工包 A → 施工包 B → 施工包 C → 施工包 D → 施工包 E → 施工包 F。每步先补失败测试、确认失败原因，再实现并运行最近测试。各包可顺序独立合入，未接入的可选能力保持默认关闭。以下新增类型、字段、事件名均为拟议接口，不代表当前已有实现。

### 施工包 A：落实 1.2.0 数据目录前置条件

依赖：无（若同版本其他工作已完成此项，核对实际提交和测试后从本功能范围删除，禁止重复改造存储体系）
**改动文件：**
- `src/main/startup/runtime-profile.ts`：production 使用独立于 1.1.x 的数据目录 `%APPDATA%\Firefly-1.2.0`。
- `src/main/startup/runtime-profile.test.ts`：覆盖新正式目录、隔离和无旧目录访问。
- `src/main/startup/runtime-profile-documentation.test.ts`：保持开发启动隔离契约。
- `README.md`：更新正式数据位置及新版本不迁移说明。

**任务：**

- [ ] A1 切换 `runtime-profile.ts` 的 production 正式目录至 `%APPDATA%\Firefly-1.2.0` 并验证与 1.1.x 隔离
  - 先写的测试：`src/main/startup/runtime-profile.test.ts`：① 新正式安装 → 完整路径对象指向新目录 `%APPDATA%\Firefly-1.2.0`；旧目录存在时也不访问旧设置、历史或数据库；② 新目录为空、旧目录含哨兵文件 → 新配置独立建立；旧哨兵内容和目录保持不变；③ 隔离根越界或与正式目录重叠 → 断言已有稳定错误码；Electron 路径应用和目录写入均未发生。
  - 实现：修改 `src/main/startup/runtime-profile.ts` 将 production 解析到 `%APPDATA%\Firefly-1.2.0`。
  - 验证：`npm test -- src/main/startup/runtime-profile.test.ts`
- [ ] A2 同步开发启动隔离文档测试与 `README.md` 正式数据位置说明
  - 先写的测试：`src/main/startup/runtime-profile-documentation.test.ts`：核对文档与 `resolveRuntimeProfile` 新正式路径及开发启动隔离契约一致。
  - 实现：修改 `src/main/startup/runtime-profile-documentation.test.ts` 与 `README.md`。
  - 验证：`npm test -- src/main/startup/runtime-profile.test.ts src/main/startup/runtime-profile-documentation.test.ts`

**验收：** 新正式目录独立建立且不读取或修改 1.1.x 数据；越界或重叠隔离根被拒绝且无写入发生。
**回退：** 若本包独立合入可 revert，但 1.2.0 不通过改回旧目录 `%APPDATA%\Firefly` 实现回退。
**工作量：** 0.5–1 人日

---

### 施工包 B：共享输出契约与尾窗

依赖：施工包 A
**改动文件：**
- 新增 `src/shared/command-output.ts`、`src/shared/command-output.test.ts`：类型、尾窗、增量合并和输入规范化。
- 修改 `src/shared/chat-types.ts`：添加可选 `commandOutput`。
- 不修改会话 schema 版本，不添加旧数据迁移器。

#### 输出契约设计

新增 `src/shared/command-output.ts`，统一主进程、渲染端和持久化边界：

```ts
type CommandOutputSnapshot = {
  text: string;
  windowTruncated: boolean;
  captureTruncated: boolean;
  finalized: boolean;
  exitCode?: number | null;
  errorCode?: string;
};

type CommandOutputUpdate = {
  action: "append" | "replace";
  text: string;
  windowTruncated: boolean;
  captureTruncated: boolean;
  finalized: boolean;
  exitCode?: number | null;
  errorCode?: string;
};
```

在 `ToolExecutionRecord` 增加可选 `commandOutput?: CommandOutputSnapshot`。不改变已有 `status: "running" | "success" | "error"`；取消、超时等原因通过命令快照元数据和原有运行终态展示，不扩大所有工具的状态枚举。

共享模块提供：
- `applyCommandOutput`：应用增量或替换，保留有界尾窗。
- `normalizeCommandOutput`：校验跨进程、磁盘和任务结果中的字段。
- `COMMAND_OUTPUT_LIMIT`：64,000 个 Unicode 码点。
- 面向伙伴记录的 `CommandExecutionRecord`：包含真实 `toolCallId`、命令、输出快照和工具状态，不包含任意工具结果、提示词或私有推理。

空字符串是有效输出；缺少 `commandOutput` 表示未接入实时记录，两者不得混淆。

**任务：**

- [ ] B1 实现 `COMMAND_OUTPUT_LIMIT`（64,000 Unicode 码点）尾窗裁剪与 `applyCommandOutput` 增量/替换合并
  - 先写的测试：`src/shared/command-output.test.ts`：① 63,999 / 64,000 / 64,001 个码点 → 比较完整尾窗和截断标记；② 中文、emoji 位于裁剪边界 → 无孤立代理项，结果不超过限额；③ `append` 后 `replace` → 完整结果等于替换快照，不残留旧预览。
  - 实现：新建 `src/shared/command-output.ts`，实现 `CommandOutputSnapshot`、`CommandOutputUpdate`、`COMMAND_OUTPUT_LIMIT` 与 `applyCommandOutput`。
  - 验证：`npm test -- src/shared/command-output.test.ts`
- [ ] B2 实现 `normalizeCommandOutput` 跨进程/磁盘输入规范化并在 `ToolExecutionRecord` 增加可选 `commandOutput`
  - 先写的测试：`src/shared/command-output.test.ts`：① 空输出、缺字段、错误类型、未知动作 → 区分合法空串和无效输入；无效输入不改变原对象；② 超长磁盘字段 → 有界尾窗并标记截断，不接受对象、数组或任意额外字段作为文本。
  - 实现：在 `src/shared/command-output.ts` 实现 `normalizeCommandOutput` 与 `CommandExecutionRecord`；修改 `src/shared/chat-types.ts` 为 `ToolExecutionRecord` 添加可选 `commandOutput?: CommandOutputSnapshot`。
  - 验证：`npm test -- src/shared/command-output.test.ts`

**验收：** `src/shared/command-output.test.ts` 5 类边界用例全部通过；合法空串与缺省字段不混淆；无孤立 UTF-16 代理项。
**回退：** revert 本包提交；仅移除共享契约文件与可选类型字段，不影响任何现有存储。
**工作量：** 0.5–1 人日

---

### 施工包 C：前台执行输出、解码、事件链与取消收尾

依赖：施工包 B
**改动文件（均位于 `src/main/orchestrator/`）：**
- 修改 `tools/registry/tool-context.ts`：可选观察回调及单次调用字段。
- 新增 `tools/builtin-tools/command-output-capture.ts`、`tools/builtin-tools/command-output-capture.test.ts`：批处理、流解码和结束重建。
- 修改 `tools/builtin-tools/run-shell-tool.ts`：接入前台捕获和终止收尾。
- 修改 `harness/tool-dispatcher.ts`：绑定调用 ID、序号和前台条件。
- 修改 `harness/types.ts`、`harness/adapter/event-mapper.ts`：事件类型和映射。
- 修改 `harness-adapter.ts`：限定取消后的命令输出收尾。
- 新增 `harness/tool-dispatcher-command-output.test.ts`；扩展 `tools/builtin-tools/run-shell-outcomes.test.ts`、`tools/builtin-tools/run-shell-capture-limit.test.ts`、`harness/adapter/event-mapper.test.ts`、`harness-adapter.test.ts`。

#### 执行、解码与事件链设计

在 `ToolContext` 增加可选 `onCommandOutput`，由分发器在单次前台 `run_shell` 调用中注入。扩展 `createToolInvocationContext` 的调用字段类型，不修改共享运行上下文对象。

执行器负责：
1. 两条流分别使用增量 UTF-8 解码器，避免跨块字符被破坏。
2. 按主进程收到数据的顺序合并展示；不宣称这是两个流的精确写入时间顺序。
3. 每 100 毫秒最多发布一次普通更新，单次文本最多 64,000 个码点；积压过大时发布尾窗 `replace`，不能丢弃前缀后仍称为普通追加。
4. 原始捕获继续遵守每流 2 MiB。新增顺序信息必须有界，不能按无限数据块追加对象。
5. 结束时先按每流完整捕获字节确定编码，再按接收顺序重建文本，发送最终 `replace`；不能对每个块独立猜测 GBK。
6. 正常结束、非零退出、spawn 错误、取消和超时均收尾一次，停止定时器，忽略重复关闭通知。
7. 输出回调异常只影响展示，不中断捕获、清理或原有结果返回。

保留最终 JSON、stdout/stderr 顺序、错误码、重试和副作用判定。系统生成的终止原因显示为状态信息，不伪装成子进程原始输出。**捕获边界语义：** 默认保留“现有已捕获数据中的最近 64,000 个码点”。某条流达到 2 MiB 后，更晚且未被捕获的内容不会出现在面板；必须显示捕获截断提示。

主流程新增 Harness 事件 `command_output`，拟映射为：

```text
CUSTOM firefly.command.output
threadId = 当前会话
runId = 当前运行
value = { toolCallId, sequence, update }
```

身份由分发器闭包绑定，`sequence` 在单次调用内递增。取消时允许该运行已启动命令的最终输出校正完成，然后关闭观察通路、发布运行终态。该例外只接受有界命令输出收尾，不恢复文本回复、工具启动或其他事件，不改变审批和进程清理。若取消调度先返回，需让观察收尾在既有终止宽限边界内完成，不能无限等待。

**任务：**

- [ ] C1 实现 `command-output-capture.ts` 双流增量 UTF-8 解码、100ms 批处理、洪流有界尾窗与结束 GBK/UTF-8 重解码
  - 先写的测试：`src/main/orchestrator/tools/builtin-tools/command-output-capture.test.ts`：① UTF-8 中文和 emoji 跨块、两流交错 → 比较完整事件序列；最终替换与重新解码结果一致；② GBK 跨块 → 最终替换纠正预览；stdout/stderr 使用各自编码判定；③ 小块持续输出（假定时器） → 99 毫秒不提前刷新，100 毫秒按契约刷新；结束不等待下一周期；④ 输出洪流 → 单次文本和缓冲有界；捕获上限两侧行为正确，stderr 不被 stdout 洪流挤掉。
  - 实现：新建 `src/main/orchestrator/tools/builtin-tools/command-output-capture.ts`，实现双流增量解码、100ms 节流刷新、有界顺序记录与结束重解码替换。
  - 验证：`npm test -- src/main/orchestrator/tools/builtin-tools/command-output-capture.test.ts`
- [ ] C2 扩展 `tool-context.ts` 并将 `run-shell-tool.ts` 前台分支接入输出捕获与终止收尾
  - 先写的测试：`src/main/orchestrator/tools/builtin-tools/run-shell-outcomes.test.ts`、`src/main/orchestrator/tools/builtin-tools/run-shell-capture-limit.test.ts`：① 非零退出、spawn 错误、超时、取消 → 保留部分输出并收尾一次；原有 `E_SHELL_EXIT`、`E_SHELL_SPAWN`、`E_TOOL_TIMEOUT`、`E_ABORTED` 等结果契约不变；② 审批拒绝、计划只读、沙箱拒绝 → 无 spawn、无原始输出事件、无输出日志文件；③ 后台执行 → 仍调用后台管理器，不发布前台输出事件；④ 回调抛错 → 工具结果、捕获和进程清理不变；收尾后无计时器继续发事件；⑤ 无回调 → 最终 JSON 与现有契约相同，不新增结果字段或改变属性顺序。
  - 实现：修改 `src/main/orchestrator/tools/registry/tool-context.ts` 与 `src/main/orchestrator/tools/builtin-tools/run-shell-tool.ts`。
  - 验证：`npm test -- src/main/orchestrator/tools/builtin-tools/run-shell`
- [ ] C3 在 `tool-dispatcher.ts`、`types.ts`、`event-mapper.ts` 与 `harness-adapter.ts` 绑定调用身份、映射 AG-UI 事件并实现取消后有界收尾
  - 先写的测试：`src/main/orchestrator/harness/tool-dispatcher-command-output.test.ts`、`src/main/orchestrator/harness/adapter/event-mapper.test.ts`、`src/main/orchestrator/harness-adapter.test.ts`：① 两个调用交错 → 每个事件 ID、序号和正文正确，不串到另一调用；② `command_output` 映射为 `CUSTOM firefly.command.output`；③ 取消先于进程关闭 → 只允许该调用的最终输出收尾；终态之后不再发布增量，也不恢复其他事件。
  - 实现：修改 `src/main/orchestrator/harness/tool-dispatcher.ts`、`src/main/orchestrator/harness/types.ts`、`src/main/orchestrator/harness/adapter/event-mapper.ts`、`src/main/orchestrator/harness-adapter.ts`。
  - 验证：`npm test -- src/main/orchestrator/tools/builtin-tools/command-output-capture.test.ts src/main/orchestrator/harness/tool-dispatcher-command-output.test.ts src/main/orchestrator/harness/adapter/event-mapper.test.ts src/main/orchestrator/harness-adapter.test.ts`

**验收：** 本包任务 C1–C3 的全部测试通过（11 项场景）；前台 `run_shell` 实时发出有界输出事件且在结束/取消/超时/异常时唯一收尾；原有结果 JSON 与错误码零回归。
**回退：** revert 本包提交；停止接入观察回调即可回到原结果展示。
**工作量：** 2–3 人日

---

### 施工包 D：聊天状态、检查点和持久化

依赖：施工包 B、施工包 C
**改动文件：**
- 修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`：严格归属校验、应用更新、保留终态输出和有界保存时机。
- 修改 `src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`：事件、保存、取消和会话隔离。
- 修改 `src/main/chats/chats-store.ts`、`src/main/chats/chats-store.test.ts`：新增字段读写边界及重开恢复。
- 扩展 `src/renderer/react/features/chat/pages/run-event-gate.test.ts`：新事件的运行隔离。
- 按实际需要扩展 `src/main/chat/agui-bridge.test.ts`，验证传输和窗口销毁行为。
- 不为本功能修改 `conversation-transcript-types.ts` 或 `conversation-transcript-store.ts`。

#### 状态与保存设计

```text
工具开始 → 运行中、等待输出
        → 有界预览
        → 最终 replace
        → 原有工具结果与运行终态
        → 保存检查点
```

沿用 `IPC.AGUI_EVENT`、preload 和 `RunEventGate`。在现有运行过滤外，接收端拒绝旧序号，最终 `replace` 能校正之前缺失的增量，并补验：
- `threadId`、权威 `runId` 和当前 assistant 归属；
- 工具记录存在且确为前台 `run_shell`；
- 载荷类型、限额、序号和完成标记合法；
- 已结束调用不再接受普通增量；
- 不根据陌生输出事件创建工具记录。

输出事件只改变命令展示记录，不进入模型消息、S/M/H 记忆、执行账本或副作用证据。命令输出保存采用“首次变脏后最多 350 毫秒写入一次”，后续输出不反复推迟该次保存；结束和取消立即保存。串行保存队列在入队时取得快照，防止后续更新改变待写内容。`chats-store` 在读取和写入消息时规范化新增字段；畸形可选输出字段丢弃，超长合法字符串裁为尾窗并标记截断，不因展示字段损坏整个会话。覆盖 `appendMessage`、`upsertMessage`、`replaceMessages`、`replaceMessagesTail` 和初始消息入口。

**任务：**

- [ ] D1 在 `AgentRunController.ts`、`RunEventGate` 与 `agui-bridge` 实现归属校验、序号过滤与终态输出保留
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`、`src/renderer/react/features/chat/pages/run-event-gate.test.ts`、`src/main/chat/agui-bridge.test.ts`：① 当前运行、正确命令 ID → 更新完整目标记录；其他记录和助手正文不变；② 错误线程、旧运行、陌生调用、非命令工具、重复序号、畸形载荷 → 不更新、不创建记录、不触发保存；③ 最终工具结果到达 → 更新原状态和 `result`，保留校正后的输出；④ 取消、超时、恢复中断记录 → 已有输出仍可见，不显示持续运行光标，不虚构成功。
  - 实现：修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`，扩展 `run-event-gate.test.ts` 与 `agui-bridge.test.ts`。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/renderer/react/features/chat/pages/run-event-gate.test.ts src/main/chat/agui-bridge.test.ts`
- [ ] D2 实现首次变脏 350ms 最大等待检查点与 `chats-store.ts` 全入口读写规范化
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`、`src/main/chats/chats-store.test.ts`：① 每 100 毫秒持续输出超过一秒（假定时器） → 首次变脏后 350 毫秒内发生保存，不被持续事件推迟；保存的是当时不可变快照；② 保存拒绝或延迟 → 不将命令标为失败、不触发重跑，后续保存队列仍能工作；③ 完成后重新初始化存储并读取 → 输出、状态和截断标记完整往返；④ 会话删除、临时会话 → 不产生独立残留命令日志；临时会话维持不落盘契约。
  - 实现：修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts` 的 `checkpointRun` 与 `src/main/chats/chats-store.ts` 的 `appendMessage`、`upsertMessage`、`replaceMessages`、`replaceMessagesTail` 及初始消息入口。
  - 验证：`npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chats/chats-store.test.ts`

**验收：** 本包任务 D1–D2 的全部测试通过（8 项场景）；持续输出期间按 350ms 上界可靠落盘；重开会话完整恢复命令输出快照；畸形字段安全降级不损坏会话。
**回退：** revert 本包提交；新数据目录中的可选 `commandOutput` 字段可保留，不自动删除数据。
**工作量：** 1.5–2 人日

---

### 施工包 E：命令面板与三种模式展示

依赖：施工包 B、施工包 D
**改动文件（组件及 workspace 路径均位于 `src/renderer/react/features/chat/`）：**
- 新增 `components/CommandOutputPanel.tsx`、`components/CommandOutputPanel.css`、`components/CommandOutputPanel.test.tsx`。
- 新增 `components/command-output-presentation.ts`、`components/command-output-presentation.test.ts`：安全解析命令、状态和可复制文本。
- 修改 `components/ChatMessageList.tsx` 及相关测试：运行中无 `result` 也显示命令面板。
- 修改 `workspace/WorkspaceRunResults.tsx`、`workspace/WorkspaceRunResults.test.ts`：右侧复用同一组件。
- 修改 `src/renderer/react/i18n/zh-CN.json`、`src/renderer/react/i18n/en.json`：新增面板文案。
- ANSI 依赖获选后修改 `package.json`、`package-lock.json`、`THIRD_PARTY_NOTICES.md`，核对实际包许可证。

#### 界面与中文 i18n 设计

新增 `CommandOutputPanel.tsx` 和独立 CSS，使用 Firefly 现有主题、字体和复制能力，自行实现界面，不移植其他产品组件或样式。面板包含命令标题、状态、输出、复制和截断提示。运行中默认展开；用户主动折叠后不被每次输出强制打开。滚动位于底部时跟随，用户上翻后停止跟随，提供“回到最新输出”。

拟新增 `commandOutput.*` 文案：
- `running`：“运行中”
- `completed`：“已完成”
- `failed`：“执行失败”
- `cancelled`：“已取消”
- `timedOut`：“已超时”
- `waiting`：“等待命令输出…”
- `empty`：“命令未产生输出”
- `copy`：“复制输出”
- `copyFailed`：“复制失败，请重试”
- `windowTruncated`：“仅保留最近 64,000 个字符”
- `captureTruncated`：“命令输出已达到捕获上限，后续内容未保留”
- `previewOnly`：“仅有结果预览，未保存命令输出”
- `followLatest`：“回到最新输出”
- `interrupted`：“运行已中断，以下为最近保存的输出”

**任务：**

- [ ] E1 锁定 ANSI 渲染依赖并实现 `command-output-presentation.ts` 与中英文 `commandOutput.*` i18n 文案
  - 先写的测试：`src/renderer/react/features/chat/components/command-output-presentation.test.ts`：① 成功、失败、取消、超时、空输出、中断恢复、缺少输出字段的 1.2.0 记录 → 状态映射和中文文案键准确（缺少输出字段的 1.2.0 记录仅展示已有结果预览并明确标注 `previewOnly`，不能宣称完整日志）；② 含 ANSI 颜色、跨块控制码、OSC 控制序列的文本 → 提取可复制纯文本时剥离控制序列，颜色跨尾窗截断时安全重置，无裸控制码。
  - 实现：核对并锁定 ANSI 依赖（如 `ansi-to-react`），更新 `package.json`、`package-lock.json`、`THIRD_PARTY_NOTICES.md`；新建 `src/renderer/react/features/chat/components/command-output-presentation.ts`；修改 `src/renderer/react/i18n/zh-CN.json`、`en.json`。
  - 验证：`npm test -- src/renderer/react/features/chat/components/command-output-presentation.test.ts`
- [ ] E2 实现 `CommandOutputPanel.tsx` 组件（含防 XSS/OSC、复制反馈、智能跟随滚动与折叠保持）
  - 先写的测试：`src/renderer/react/features/chat/components/CommandOutputPanel.test.tsx`（交互断言使用 jsdom 和真实事件，不能只靠静态 HTML 字符串证明滚动或复制行为）：① 运行中且没有 `result` → 命令、等待文案和面板可见；② 成功、失败、取消、超时、空输出 → 状态和中文文案正确，结束后无活动光标；③ 有输出、ANSI 颜色、跨块控制码 → 文本可读，颜色受控，无裸控制码；④ HTML、脚本、危险链接、OSC 控制序列 → 不执行、不导航、不写剪贴板、不发网络请求；⑤ 点击复制 → 参数恰为当前保留的纯文本；复制失败显示失败反馈，不显示成功；⑥ 用户上翻或主动折叠 → 后续输出不抢滚动、不强制展开；回到底部后恢复跟随。
  - 实现：新建 `src/renderer/react/features/chat/components/CommandOutputPanel.tsx` 与 `CommandOutputPanel.css`。
  - 验证：`npm test -- src/renderer/react/features/chat/components/CommandOutputPanel.test.tsx`
- [ ] E3 接入 `ChatMessageList.tsx` 与 `WorkspaceRunResults.tsx` 并验证三模式与窄窗口布局
  - 先写的测试：`src/renderer/react/features/chat/workspace/WorkspaceRunResults.test.ts` 及现有消息列表测试：① 缺少输出字段的 1.2.0 记录 → 仅展示已有结果预览并明确标注；② Chat / Work / Code 展示 fixture → 共用组件正常，模式工具目录测试确认 Chat 仍无 `run_shell`；③ 窄窗口、长行和其他工具 → 输出不撑破容器，其他工具卡片展示不回归。
  - 实现：修改 `src/renderer/react/features/chat/components/ChatMessageList.tsx` 与 `src/renderer/react/features/chat/workspace/WorkspaceRunResults.tsx`。
  - 验证：`npm test -- src/renderer/react/features/chat/components/CommandOutputPanel.test.tsx src/renderer/react/features/chat/workspace/WorkspaceRunResults.test.ts`；`npm run check:renderer`

**验收：** 本包任务 E1–E3 的全部测试通过（9 项场景）；聊天卡片与右侧结果共用 `CommandOutputPanel`；ANSI 渲染安全无 XSS/OSC 副作用。
**回退：** revert 本包提交；卡片与右侧面板退回原有 `tool.result` 展示。
**工作量：** 1.5–2.5 人日

---

### 施工包 F：伙伴前台命令与整链回归

依赖：施工包 C、施工包 D、施工包 E
**改动文件：**
- 修改 `src/shared/command-output.ts`、`src/shared/task-session.ts`、`src/shared/chat-types.ts`、`src/shared/task-result-evidence.ts`、`src/shared/task-result-evidence.test.ts`：伙伴命令展示契约和规范化。
- 修改 `src/main/orchestrator/child-session-types.ts`、`src/main/orchestrator/child-session-runtime.ts`：窄观察回调、身份绑定、保存和收尾。
- 修改 `src/main/orchestrator/persistent-agent-runtime.ts`、`src/main/orchestrator/persistent-agent-runtime.test.ts`：透传观察能力和最终命令记录。
- 修改 `src/main/orchestrator/harness/adapter/tool-runtime.ts`、`src/main/orchestrator/harness/builtin-tools.ts`、`src/main/orchestrator/harness/adapter/event-mapper.ts`：传递并发布伙伴展示信息。
- 修改 `src/main/tasks/task-session-store.ts`、`src/main/tasks/task-session-store.test.ts`、`src/main/tasks/task-session-runtime-store.test.ts`：命令记录检查点、读取校验与续跑隔离。
- 修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`、`src/renderer/react/features/chat/components/ChatMessageList.tsx`、`src/renderer/react/features/chat/workspace/WorkspaceRunResults.tsx`：更新对应委派卡片及重开展示。
- 新增 `src/main/orchestrator/command-output.integration.test.ts`：命令输出整链集成测试。

#### 伙伴命令设计

Work / Code 的伙伴前台命令纳入范围，但不把子任务通用事件直接转发为父工具事件：
- 子任务运行时按 `(childRunId, toolCallId)` 收集有界命令记录。
- 在 `TaskSession` 增加可选命令记录集合，使用现有任务存储保存；续跑时按新 `childRunId` 隔离。
- 通过 Main 持有的窄回调发送 `firefly.task.command_output`，携带父运行、委派调用、任务、子运行和命令调用身份。
- 父控制器把记录归到对应委派卡片，不能计为父流程直接运行的命令。
- 在 `ToolTaskResult` 增加可选命令记录字段，最终委派结果能够校正运行中的记录；同步更新 `normalizeToolTaskResult`。
- 只展示命令、stdout/stderr、状态和截断信息，不公开子任务提示词、推理或完整轨迹。

本包不拆分：伙伴前台命令链路（共享类型、子会话收集、Main 窄回调、任务会话保存、渲染端归属与委派卡片展示）必须同一个 PR 合入，拆开后任一中间状态都会出现事件无处归属或展示无数据来源。

**任务：**

- [ ] F1 扩展 `TaskSession`、`ToolTaskResult`、`normalizeToolTaskResult` 与 `task-session-store.ts` 持久化及续跑隔离
  - 先写的测试：`src/shared/task-result-evidence.test.ts`、`src/main/tasks/task-session-store.test.ts`、`src/main/tasks/task-session-runtime-store.test.ts`：① 同一任务续跑产生新子运行 → 新旧记录按 `childRunId` 分离，迟到事件不能污染新运行；② 伙伴取消、超时和存储重开 → 保存有界部分输出及正确终态。
  - 实现：修改 `src/shared/command-output.ts`、`src/shared/task-session.ts`、`src/shared/chat-types.ts`、`src/shared/task-result-evidence.ts`、`src/main/tasks/task-session-store.ts`。
  - 验证：`npm test -- src/shared/task-result-evidence.test.ts src/main/tasks/task-session-store.test.ts src/main/tasks/task-session-runtime-store.test.ts`
- [ ] F2 在 `child-session-runtime.ts`、`persistent-agent-runtime.ts` 与委派工具链透传 `firefly.task.command_output` 并验证隐私隔离
  - 先写的测试：`src/main/orchestrator/persistent-agent-runtime.test.ts`：① 两个伙伴使用相同 `toolCallId` → 按不同 `childRunId` 隔离，父卡片与另一伙伴不变；② 输出正文与私有提示词使用不同哨兵 → 只出现允许的命令输出；父消息、模型输入和通用日志中没有私有哨兵。
  - 实现：修改 `src/main/orchestrator/child-session-types.ts`、`src/main/orchestrator/child-session-runtime.ts`、`src/main/orchestrator/persistent-agent-runtime.ts`、`src/main/orchestrator/harness/adapter/tool-runtime.ts`、`src/main/orchestrator/harness/builtin-tools.ts`、`src/main/orchestrator/harness/adapter/event-mapper.ts`。
  - 验证：`npm test -- src/main/orchestrator/persistent-agent-runtime.test.ts`
- [ ] F3 在 `AgentRunController.ts` 与界面委派卡片接入伙伴命令展示，并完成 `command-output.integration.test.ts` 整链回归
  - 先写的测试：`src/renderer/react/features/chat/pages/run/AgentRunController.test.ts`、`src/main/orchestrator/command-output.integration.test.ts`：① 最终委派结果到达 → 校正实时记录，不抹除命令输出；② 伪造父运行、委派调用或任务身份 → 不展示、不保存，不泄露其他任务内容；③ 假进程→工具→Harness→AG-UI→控制器→存储重开 → 命令未结束时已可见；结束后输出完成校正并可恢复。
  - 实现：修改 `src/renderer/react/features/chat/pages/run/AgentRunController.ts`、`src/renderer/react/features/chat/components/ChatMessageList.tsx`、`src/renderer/react/features/chat/workspace/WorkspaceRunResults.tsx`；新建 `src/main/orchestrator/command-output.integration.test.ts`。
  - 验证：`npm test -- src/main/orchestrator/persistent-agent-runtime.test.ts src/main/tasks/task-session-store.test.ts src/shared/task-result-evidence.test.ts src/main/orchestrator/command-output.integration.test.ts`

**验收：** 本包任务 F1–F3 的全部测试通过（7 项场景）；并行伙伴命令按真实身份严格隔离，子任务私有轨迹零泄露；整链集成测试通过。
**回退：** revert 本包提交；主流程命令实时输出保留，伙伴委派退回原展示方式。
**工作量：** 2–3 人日

## 验收清单（全量）

以下是施工期间的验证命令，**本轮只写计划，均未执行**。所有命令只在 Firefly 工作树执行，不把外部参考文档目录加入测试、构建或运行路径。`package.json:105` 要求 Node 24；测试入口为 `package.json:189` 的包装脚本，`scripts/testing/run-tests.mjs` 会透传测试参数并保留归档报告。

- [ ] 各施工包最近测试全部通过：
  ```powershell
  npm test -- src/main/startup/runtime-profile.test.ts src/main/startup/runtime-profile-documentation.test.ts

  npm test -- src/shared/command-output.test.ts

  npm test -- src/main/orchestrator/tools/builtin-tools/command-output-capture.test.ts src/main/orchestrator/harness/tool-dispatcher-command-output.test.ts src/main/orchestrator/harness/adapter/event-mapper.test.ts

  npm test -- src/renderer/react/features/chat/pages/run/AgentRunController.test.ts src/main/chats/chats-store.test.ts

  npm test -- src/renderer/react/features/chat/components/CommandOutputPanel.test.tsx src/renderer/react/features/chat/workspace/WorkspaceRunResults.test.ts

  npm test -- src/main/orchestrator/persistent-agent-runtime.test.ts src/main/tasks/task-session-store.test.ts src/shared/task-result-evidence.test.ts src/main/orchestrator/command-output.integration.test.ts
  ```
- [ ] 相关模块测试全部通过：
  ```powershell
  npm test -- src/main/orchestrator/tools/builtin-tools/run-shell
  npm test -- src/main/orchestrator/harness
  npm test -- src/main/chats src/main/tasks
  npm test -- src/renderer/react/features/chat
  ```
- [ ] 整链合入前检查与构建全部通过（见 `package.json:160–172、189`）：
  ```powershell
  npm run check:storage-boundary
  npm run build:main
  npm run build:preload
  npm run check:renderer
  npm run build:renderer
  npm test
  git diff --check
  ```
- [ ] Windows 真机验证（使用新的隔离目录，显式设置 `FIREFLY_RUNTIME_PROFILE=development`、`FIREFLY_ISOLATION_ROOT` 后运行 `npm run dev`，目录必须位于旧正式数据根之外，启动前为空；记录实际通过、失败和显式跳过项）：
  1. 在 Work、Code 各执行逐秒输出中文、emoji、stdout/stderr 的短命令，确认进程尚未结束时已有输出。
  2. 执行输出洪流，确认窗口仍可操作、尾窗有界、截断提示准确。
  3. 分别取消、设置短超时、执行非零退出命令，检查部分输出、真实终态和进程树清理。
  4. 并行委派两个伙伴执行不同哨兵命令，确认归属正确。
  5. 上翻、折叠、复制、切换会话和重开应用，检查跟随与恢复。
  6. 在 Chat 检查没有新增命令执行入口；测试后台命令仍走原有作业方式。
  7. 检查深浅主题、窄窗口、键盘操作和屏幕阅读标签。
  8. 在隔离安装环境验证正式新目录 `%APPDATA%\Firefly-1.2.0`，确认没有读取 1.1.x 数据。

## 回滚方案

| 风险 | 控制及回退 |
|---|---|
| Windows 实时预览暂时乱码 | 保留结束重解码和替换；异常时显示已有文本，不修改最终工具结果。 |
| 输出洪流拖慢 IPC、渲染或保存 | 批处理、单次载荷、尾窗、元数据和检查点均有界；停止接入观察回调即可回到原结果展示。 |
| 取消丢失最终输出或延迟结束 | 专门测试事件收尾顺序和宽限边界；不放开其他取消后事件。 |
| 伙伴输出串流或泄露私有内容 | 多重真实身份关联，使用窄展示契约，不转发通用子任务轨迹。 |
| 新字段导致历史读取失败 | 字段可选，集中规范化；畸形展示字段降级，不覆盖原始损坏文件。 |
| ANSI 控制序列或依赖不兼容 | 封装渲染边界，禁止 HTML 和控制动作；可降级为安全纯文本，保留输出数据。 |
| 新目录与 1.1.x 混用 | 目录隔离作为上线前置条件；没有隔离验证，不进入正式验收。 |
| 会话总体积增加 | 每条命令有界，但命令总数仍会累积；本次不引入全量日志存储或自动清理策略。 |

回退按施工包逆序撤销功能接入，保留原有工具捕获、结果存储和审批路径。新数据目录中的可选输出字段可保留；不自动删除数据，不把 1.2.0 数据复制回 1.1.x，也不通过改回旧目录实现回退。

## 待负责人决定

> **负责人决定（2026-11-12）**：本节推荐选项全部采纳；1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`。

已采纳并写入全局约束与对应施工包的结论：
- 1.2.0 正式数据目录名称与归属：使用 `%APPDATA%\Firefly-1.2.0`，由版本基础主题统一落实；本功能以上线前置条件验收（施工包 A），避免多份计划重复修改。
- Chat 是否新增命令执行能力：不新增。实时展示沿用 Work / Code 当前权限范围；开放 Chat 命令另立需求（施工包 C/E）。
- 伙伴命令是否首版交付：纳入首版，采用本计划的独立归属和窄展示字段；不展示子任务私有轨迹（施工包 F）。
- “最近 64,000 字符”的捕获含义：保持每流 2 MiB 捕获契约，只展示已捕获数据的尾窗，并明确提示；若要求持续保留进程真正最后输出，需要另行调整捕获设计（施工包 B/C）。
- 字符计数：使用 Unicode 码点，避免截断 emoji 的代理对；产品文案继续称“字符”（施工包 B/E）。
- ANSI 依赖：允许增加一项专用运行依赖；接入前核对官方 API、实际版本、React 兼容性、许可证和控制序列行为，并锁定版本（施工包 E）。
- 原始命令输出的本地保存：随会话保存有界输出，继承会话删除行为；不增加遥测、搜索索引或模型上下文。需明确输出可能包含命令自身打印的敏感内容（施工包 D）。
- 窗口关闭或应用崩溃的保证：首版保证恢复最近成功检查点，不承诺崩溃零丢失；若要求窗口关闭后仍可靠保存全部尾窗，另补 Main 持有的持续观察存储（施工包 D）。

仍真正未决的项：无。

## 工作量

按一名熟悉仓库的工程师估算，包含测试和问题修复：

| 施工包 | 估计 |
|---|---:|
| 施工包 A：新目录前置条件 | 0.5–1 人日 |
| 施工包 B：共享契约与尾窗 | 0.5–1 人日 |
| 施工包 C：执行器、解码、事件与取消收尾 | 2–3 人日 |
| 施工包 D：控制器、保存与恢复 | 1.5–2 人日 |
| 施工包 E：面板、ANSI、i18n 与右侧展示 | 1.5–2.5 人日 |
| 施工包 F：伙伴命令及整链回归 | 2–3 人日 |
| Windows 真机验收及回退核对 | 1–1.5 人日 |
| **合计** | **9.5–14 人日** |

若新目录已由发布工作完成，扣除对应工时。主要不确定性集中在取消收尾顺序、Windows 编码重建、ANSI 兼容性和伙伴结果归属，不以删除边界测试或降低验证要求压缩工期。
