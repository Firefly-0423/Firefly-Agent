# 主进程分层设计

状态：设计提案（待负责人确认目录方案）
日期：2026-11-12
基线：`refactor/main-layering` 的 `f1a1c46`（在 `dev/firefly-1.2.0` 的 `3ef7862` 之上）

## 1. 为什么要分层

排查结果（工具和原始数据在 `output/audit-1.2.0/`）：

- 类型检查三端通过；IPC 235 个通道无重复、无未用、无缺处理方；文件之间真正的运行时循环只有 2 个。代码本身是能工作的。
- 问题在目录之间：`src/main` 的 50 个目录没有上下层关系，其中 37 个互相可达。任何一个目录的改动，理论上都可能影响其余 36 个。
- 根源有两个：
  1. **通用小工具放在了上层目录**（如 IPC 注册工具放在组合根里），下层只好反过来引用上层。第一批 12 个已经挪走（提交 `f1a1c46`）。
  2. **`orchestrator` 一个目录装了六件事**：模型接入、会话记录、工具注册契约、内置工具、MCP、智能体运行循环。记忆、设置等模块只需要其中的“模型类型”或“会话记录”，却不得不引用整个 `orchestrator`。

分层之后：每个目录只属于一层，只能引用同层和下层；每一层有自己的 `AGENTS.md` 和施工文件，改动的影响范围可以直接从层级看出来。

## 2. 规则

1. **只许向下引用**：一个模块可以引用同层和更低层的模块，不能引用更高层，类型引用也不行。上层需要把东西交给下层时，由上层在启动时注入（传函数或接口），或者把共用的类型下沉到下层。
2. **同层之间不成环**：同一层的两个模块不能互相引用。
3. **组合根只做装配**：`app/` 负责创建各模块并把依赖传进去，自己不写业务逻辑；其他层不引用 `app/`。
4. **跨进程只走契约**：渲染进程和预加载脚本只引用 `src/shared`，不引用 `src/main`。
5. 规则由一个依赖方向测试守住（§6），新增的违规会让测试失败。

## 3. 目标结构

七层，自下而上。括号里是现在的目录。

```
src/main/
  base/            L0 基础：不依赖任何业务
    utils/           通用小函数（utils）
    logging/         日志（logging）
    runtime-policy/  超时与预算策略（runtime-policy）
    identity/        应用身份、运行档案、数据目录（startup）
    storage/         存储上下文、原子写、设置文件（storage）
    ipc/             IPC 注册范围（ipc）
    prompts/         提示词文件加载（prompts）
    security/        安全相关的回归测试与补丁（security）

  platform/        L1 平台服务：桌面能力，不懂“对话”
    settings/        通用设置与设置门面（settings 中与模型无关的部分）
    permission/      权限档位与审批（permission）
    interaction/     向用户提问、提醒事件（interaction）
    windows/         窗口管理与激活（windows）
    toast/           提醒窗口（toast）
    updater/         应用更新（updater）
    screenshot/      截图（screenshot）
    speech/          语音识别与播放（asr、audio、mossland）
    lsp/             语言服务（lsp）
    git/             Code 模式的 Git（code-git）
    browser/         浏览器控制（browser）
    music/           音乐（music）
    stickers/        贴纸（stickers、protocols）

  model/           L2 模型接入：怎么调用模型
    providers/       各厂商适配、请求、重试（orchestrator/vendors）
    structured/      结构化输出（orchestrator/structured-output）
    config/          模型档案与能力（orchestrator/model-config、config，settings 里的 model-*）
    text/            模型文本处理（orchestrator/text）
    vision/          图片转述与路由（vision-captioner、image-router、image-caption）

  conversation/    L2 会话记录：对话的权威记录
    transcript/      会话记录的类型、存储、结算（orchestrator/conversation-transcript-*、transcript-sink、controlled-responses）

  tooling/         L2 工具契约：工具长什么样、怎么注册
    registry/        注册表、上下文、参数校验、结果归一（orchestrator/tools/registry，不含内置工具的登记）

  knowledge/       L3 知识：检索与技能
    rag/             文档索引与检索（rag）
    workspace/       知识工作区（knowledge）
    skills/          技能安装与市场（skills）
    social/          社交上下文与关系记录（social-context、relationship）

  memory/          L3 记忆
    legacy/          早期记忆库与 Obsidian 导出（memory）
    core/            记忆库核心与事务（memory-core）
    policy/ recall/ shadow/ sources/ history/   （memory-policy 等）
    context/         每轮上下文组装（memory-context）

  agent/           L4 智能体运行
    loop/            运行循环（orchestrator/harness；1.2 改名为 agent loop）
    runtime/         运行入口、提示词组装、上下文管理、伙伴会话（orchestrator 根目录其余文件、tasks）
    tools/           内置工具及其登记（orchestrator/tools 其余、review、sandbox、shell-*）
    mcp/             MCP 接入（orchestrator/mcp-*、sync-mcp-builtin）
    llm/             后台模型任务队列（services）

  features/        L5 功能入口：把能力接到用户面前
    chat/            聊天窗口桥接（chat）
    sessions/        会话存储与会话 IPC（chats）
    channels/        外部渠道（channels）
    scheduler/       定时任务（scheduler）
    proactive/       主动聊天（proactive）
    plugins/         插件宿主与面板（plugin-host、plugin-panel）
    settings-ipc/    设置窗口的 IPC（settings/settings-ipc 等）
    diagnostics/     诊断与仿真入口（memory-online-once、memory-openrouter-once、sim、device-simulation）

  app/             L6 组合根：只做装配（application、index.ts）
```

`src/renderer`、`src/preload`、`src/shared`、`src/plugins` 的整理另写设计（§8）。

## 4. 每层的职责和边界

| 层 | 负责 | 不负责 | 可以引用 |
|---|---|---|---|
| L0 `base` | 文件、日志、身份、IPC 注册这些与业务无关的基础 | 任何“对话”“模型”“记忆”概念 | 只有自己 |
| L1 `platform` | 桌面平台能力和用户交互通道 | 模型调用、会话内容 | L0 |
| L2 `model` | 把一次请求发给模型并拿回结果；模型档案和能力 | 工具执行、记忆、运行循环 | L0–L1 |
| L2 `conversation` | 会话记录的格式、存储和结算 | 怎么生成回复 | L0–L1、`model` 的类型 |
| L2 `tooling` | 工具的定义、注册、参数校验契约 | 具体工具的实现 | L0–L1 |
| L3 `knowledge` | 文档检索、知识工作区、技能 | 运行循环 | L0–L2 |
| L3 `memory` | 记忆的提取、存储、召回和每轮上下文 | 运行循环、渠道、会话窗口 | L0–L2、`knowledge` |
| L4 `agent` | 一次运行：组装提示词、调用模型、执行工具、伙伴委派、MCP | 窗口、渠道、定时触发 | L0–L3 |
| L5 `features` | 聊天窗口、会话、渠道、定时任务、主动聊天、插件、设置 IPC | 装配 | L0–L4 |
| L6 `app` | 创建各模块并注入依赖；启动与退出顺序 | 业务逻辑 | 全部 |

L2 的三个模块之间：`conversation` 可以引用 `model` 的类型；`tooling` 不引用另外两个。L3 的 `memory` 可以引用 `knowledge`，反过来不行。

## 5. 现状与目标的差距

按 §3 的归属套到现有代码上（`layers.cjs` + `layers-v3.json`），第一批挪动之后还剩 **105 处向上引用**（58 处运行时、47 处仅类型），分布在 43 对目录之间；另有 16 对同层互相引用。逐条清单见 `output/audit-1.2.0/layers-v3-report.txt`。按修法归类：

| 类别 | 例子 | 数量（约） | 修法 |
|---|---|---|---|
| A 类型放得太高 | `memory-context` 引用 `firefly-agent.ts`、`harness/types.ts` 的类型；`conversation-transcript-types` 引用 `harness/types`；`orchestrator` 引用 `channels/types`、`agui-bridge` 的类型 | 45 | 把这些类型下沉到所属下层（`conversation`、`model`、`tooling` 或 `src/shared`） |
| B 文件归属错了 | `settings/model-*`、`fetch-vendor-models` 属于模型；`settings-ipc` 属于功能入口；`tool-registration.ts` 属于内置工具；`agent-runtime-error.ts`、`prompt-layers.ts` 被模型层使用 | 30 | 挪文件（和第一批一样，行为不变） |
| C 下层直接调用上层 | `tool-registry` 直接调用 `memory-store`、`rag`；`music/bootstrap` 登记音乐工具；`windows` 调用 `chats-store`；`memory-user-ipc` 调用 MCP 和贴纸设置 | 20 | 反转：由上层（或组合根）在启动时注入回调或登记，下层只留接口 |
| D 记忆各库互相引用 | `memory-core/repository.ts` 引用 5 个上层库；`memory-context` 与其余 6 个库互相引用 | 15 对 | 在 `memory` 内部再分三层：`core` → `policy / recall / shadow / sources / history` → `context`；`core/repository.ts` 的聚合职责上移到 `context` |
| E 渠道概念漏到下层 | `memory-context`、`memory-sources`、`relationship` 引用 `channels/types`、`channel-context` | 8 | 渠道的身份与上下文类型下沉到 `src/shared` 或 `conversation` |

文件级的两个运行时循环（`obsidian-exporter ↔ memory-store`、`ChatMessageList ↔ StreamdownMessageContent`）单独修。

## 6. 怎么守住

新增 `src/main/layering.test.ts`（一个普通的 Vitest 测试，不引入新工具）：

- 读取层级表（与本文 §3 一致的一份 JSON），解析 `src/main` 下非测试文件的全部引用；
- 断言：没有向上引用；同层没有互相引用；除 `app/` 外没有模块引用 `app/`；
- 过渡期间允许一份“已知违规清单”，清单只能减少不能增加：新增违规测试失败，修掉一条就从清单删掉一条，清空后删除清单机制。

## 7. 每一层的 AGENTS.md 和施工文件

每个层目录放一份 `AGENTS.md`（`src/main/base/AGENTS.md` 等），内容固定为：

1. 这一层负责什么、不负责什么（取自 §4）；
2. 可以引用哪些层；对外提供的入口文件；
3. 层内各模块一句话职责和主入口；
4. 这一层的验证命令（最近的测试目录、类型检查）；
5. 指向这一层的施工文件（`docs/superpowers/plans/` 下对应的计划和进度）。

仓库根目录的 `AGENTS.md` 保留通用约定，并列出七层及其 `AGENTS.md` 的位置。之后的开发按“所在层的 AGENTS.md + 该层的施工文件”进行。

## 8. 不在本设计内

- `src/renderer`：设置窗口（原生 TS，`settings.ts` 1630 行、引用 70 个文件）和聊天窗口（React，`ChatPage.tsx` 1593 行、引用 63 个文件）的分层，另写设计。
- `src/preload/index.ts`（1258 行，一个文件暴露全部 235 个通道）按功能拆分，另写设计。
- `src/plugins` 与 `plugin-sdk`（`api.ts` 两份完全相同）：随插件 SDK 1.2.0 重写处理。
- 约 17 个只有测试引用的疑似死文件：逐个确认后删除，单独一个施工包。

## 9. 施工顺序（概要，细节见施工计划）

1. 包 A（已完成）：挪 12 个放错位置的通用文件。
2. 包 B：依赖方向测试 + 已知违规清单（先把现状锁住，不再变坏）。
3. 包 C：拆 `orchestrator`：按 §3 把文件挪到 `model`、`conversation`、`tooling`、`agent`（只挪不改）。
4. 包 D：其余目录归入七层（只挪不改），各层放 `AGENTS.md`。
5. 包 E–I：按 §5 的 A–E 五类逐类清零违规清单，每类一个或多个 PR。
6. 包 J：两个文件级循环；包 K：死代码。

每个包都要求：三端类型检查通过、全量测试通过、存储边界检查通过；挪文件的包不改任何行为。

## 10. 待负责人决定

| # | 问题 | 推荐 |
|---|---|---|
| 1 | 是否按 §3 **实际挪动目录**（`src/main/base/…`、`platform/…` 等），还是保留现有目录、只用层级表和测试约束 | 实际挪动：目录本身就能看出层级，每层的 `AGENTS.md` 有明确位置；代价是几乎所有文件路径都变，7 份施工计划里的路径要跟着批量替换（可用脚本完成） |
| 2 | 层和模块的命名（§3 的英文目录名） | 按 §3；有想改的名字现在定，之后改名成本高 |
| 3 | `orchestrator/harness` 是否在挪动时同时改名为 `agent/loop` | 是，和 1.2 的 agent loop 改名合并成一次，避免同一批文件挪两遍 |
