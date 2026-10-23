<p align="center"><b>简体中文</b> · <a href="./README.en.md">English</a></p>

<p align="center"><b>与流萤交流，把想法变成可以继续的行动。</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=flat&logo=electron&logoColor=white" alt="Electron 技术标签" height="22">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript 技术标签" height="22">
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black" alt="React 技术标签" height="22">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white" alt="Rust 技术标签" height="22">
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white" alt="SQLite 技术标签" height="22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT 许可证" height="22">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=flat" alt="平台：Windows" height="22">
</p>

<p align="center">以《崩坏：星穹铁道》流萤为角色的 Windows Live2D 桌面伴侣与 AI 工作台。</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#功能">功能</a> · <a href="#安全与隐私">安全与隐私</a> · <a href="#界面展示">界面展示</a> · <a href="#当前状态与限制">状态与限制</a><br>
  <a href="https://github.com/Firefly-0423/Firefly-Agent">项目仓库</a> · <a href="https://github.com/Firefly-0423/Firefly-Agent/issues">问题反馈</a>
</p>

## 速览

Firefly_Agent 把一个会陪你聊天的桌面角色，和一个能真正动手干活的 Agent 工作台放在同一个窗口里。你可以和流萤闲聊，也可以把文档整理、代码修改、资料检索、日程提醒交给她，并在每一步看到她做了什么、需要你批准什么。

- **有人设，也有边界**：对话遵循流萤的原作设定与说话方式；工具、权限、审批和结果真实性不会因为角色语气而放宽。
- **三种模式，一个入口**：Chat 陪伴、Work 推进任务、Code 处理代码，按场景切换，各自有独立的提示词与工具集。
- **记忆在本地**：个人记忆与历史检索保存在本机，使用 SQLite；是否发送到外部服务取决于你选择的模型与工具。
- **默认克制**：写文件、执行命令、联网操作都经过权限等级和审批；浏览器里手动授权不会变成 Agent 的授权。
- **可扩展**：Skills、本地插件、MCP 服务和外部渠道都是可选项，按需开启。

| Chat · 桌面陪伴 | Work · 推进任务 | Code · 代码工作区 |
| --- | --- | --- |
| 角色化对话、流式回复与会话历史；Live2D 表情与待机动作。 | 文件、文档与知识资料；调用工具与 Skills，与专业 Agent 协作。 | 在绑定工作区里使用 Git、LSP、AST、文件与命令工具。 |

## 快速开始

需要 Windows、Node.js 24 与 npm 10 以上；本地打包另需 Rust（MSVC 工具链）与 C++ 构建工具。源码不附带可直接使用的模型、语音资源或账户凭据。

```powershell
git clone https://github.com/Firefly-0423/Firefly-Agent.git
cd Firefly-Agent
npm ci
```

用仓库内的开发隔离目录启动，不会碰你的正式数据：

```powershell
$fireflyDevRoot = Join-Path (Get-Location).Path "output\development-profile"
New-Item -ItemType Directory -Force -Path $fireflyDevRoot | Out-Null
$env:FIREFLY_RUNTIME_PROFILE = "development"
$env:FIREFLY_ISOLATION_ROOT = (Resolve-Path -LiteralPath $fireflyDevRoot).Path
npm run dev
```

隔离根必须是已存在的绝对目录，不能与正式 appData 目录相同或互为父子目录，否则拒绝启动。从当前源码的构建产物启动，在设置了上述变量的同一会话里执行 `npm run build` 与 `npm start`。

第一次打开后：

1. 在设置里创建**模型档案**：填写服务支持的协议、地址、模型和你自己的凭据；OpenRouter 有现成预设。
2. 选择 **Chat / Work / Code**。Work、Code 按任务绑定工作区，并为专业 Agent 选择已保存的模型档案；没配置时会明确报错，不会静默失败。
3. 按需开启工具、Skills、插件或 MCP。涉及写文件、执行命令和外部操作时，会走审批并且可以随时取消。

常用检查与打包入口都在 [package.json](./package.json)：`npm run check:renderer`、`npm test`、`npm run check:plugin-sdk`、`npm run validate:skills`、`npm run package:win:dir`。脚本说明见 [scripts/README.md](./scripts/README.md)。

## 功能

### 桌面陪伴与 Chat

- Live2D 流萤：双击互动表情、拖动、待机动作，工具执行时有工作表情。
- 角色化对话、流式回复、会话历史；可开启临时对话，不进入历史。
- 人设来自分层提示词与世界观条目（背景、故事、说话方式、原作台词范例），按话题条件触发，不是每轮都灌入。
- 可选的**主动聊天**：按时段、静默时长和未回复次数克制地开口，用户没回应就不会继续打扰；可在聊天偏好里调整。
- 桌面语音输入（ASR）可选关闭、Mossland 或阿里云；停止录音后转写只填入输入框，不会自动发送。

### Work：推进任务

- 处理文件、文档与知识资料，调用内置工具与 Skills，并交给专业 Agent 协作；工具执行、审批与取消都可见。
- 内置文件读写与补丁、Word / Excel / PDF 文档工具、网页搜索与正文读取、文件下载、定时任务与日程。
- 已结束的任务可导出为 Markdown；“任务完成”和“文件已完整读取”分开展示，避免把没读完的当成读完。
- **知识工作区**：绑定已有 Obsidian Vault 或学习资料目录，提供学习、测验、笔记和进度。只有已有 `learn/progress.md` 的 Vault 才维护进度，普通任务不会擅自创建学习目录。

### Code：代码工作区

- 在绑定的工作区里阅读和修改代码：Git、LSP、结构化搜索与改写（ast-grep）、文件与命令工具。
- 命令通过受控的 shell 工具运行，带超时与进程树清理；语言服务器需要本机有对应语言环境。
- 右侧面板可打开文件、差异审阅、浏览器与任务面板，并可拖动停靠。

### 记忆与知识

- 默认记忆链分三层：当前上下文（S）、事实记忆（M）、历史检索（H）。SQLite 保存现行记忆核心。
- 历史缺少可信快照时，会如实报告“覆盖不足”，不会把没找到说成不存在。
- 角色与文档知识 RAG（含 BGE-M3）独立配置，不承担默认的个人记忆或历史检索。

### 网页、扩展与渠道

- **浏览器工作区**：手动浏览与 Agent 操作严格分离；Agent 只能在 Main 当前批准的域名与动作范围内使用，不能自行授权。下载、Cookie 与站点数据有各自的受限入口。
- **Skills**：内置并校验 50 项第三方及适配 Skills 与 4 项项目 Skills，可按模式启用并由用户覆盖。
- **插件**：本地插件宿主、隔离面板、插件 SDK 与示例（[packages/plugin-sdk](./packages/plugin-sdk)、[examples](./examples)）。
- **MCP**：可配置外部 MCP 服务（stdio、SSE、HTTP）。
- **渠道**：保留 QQ、QQ Bot、微信、飞书的渠道适配，需自行配置凭据；Firefly 手机 App 目前只是预留接入位。
- **音乐**：可读取 Windows 上 QQ Music 的播放会话。

### 模型

- 提供 OpenRouter 预设与 Chat Completions 入口；图像输入按“用户声明 → 厂商模型列表 → 内置目录”逐层判定，无法确认时按纯文本处理。
- 具体效果取决于所选模型与服务；推理内容回放、流式错误等兼容性需要针对具体上游验收。

## 安全与隐私

- **权限等级与审批**：文件与命令按只读、项目只读、受限、完全等等级运行；写入、命令和外部操作遵循审批并可取消。角色、Skills 和头像不会扩大工具权限。
- **命令执行**：Shell 工具有总时长与空闲超时，结束或取消时清理整个进程树。
- **浏览器**：手动授权不授予 Agent 操作权；私有网络目标有单独限制。
- **本地数据**：设置、凭据、历史与用户 Skills 不进入 Git 或安装包。记忆数据库的密钥使用 Windows DPAPI 保护，渠道凭据使用系统加密存储。
- **数据位置**：正式数据默认在 `%APPDATA%\Firefly`，开发实例使用隔离目录；手工处理前请退出应用并备份。
- **外部服务**：根据所选模型与操作，对话、资料、工具结果和录音可能发送到外部服务；请只在信任的服务上使用。

## 界面展示

<picture>
    <source media="(prefers-color-scheme: dark)" srcset="./readme-assets/screenshots-pending-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./readme-assets/screenshots-pending-light.svg">
    <img src="./readme-assets/screenshots-pending-light.svg" alt="真实电脑端界面截图待补充：桌面流萤与 Chat、Work 任务与工具；此图仅标示展示位置" width="896">
  </picture>

**真实界面截图待补充**。顶部角色来自现有 Live2D 模型渲染画面，不能代替真实产品界面截图。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行环境 | Node.js 24 + Electron 43 |
| 语言与构建 | TypeScript、Vite 7、electron-builder |
| 界面 | React 19、Ant Design 6 / Ant Design X、Tailwind CSS 4、react-resizable-panels |
| Live2D | PixiJS 7 + pixi-live2d-display |
| Agent | 自研 Harness 主循环、AG-UI 事件协议、原生工具调用 |
| 工具与代码 | 自研工具调度与审批、LSP 客户端、`@ast-grep/napi`、`simple-git`、MCP SDK |
| 记忆与检索 | SQLite（`node:sqlite`）、Embedding、BM25、Reranker |
| 浏览器 | Electron 内置浏览器工作区 |
| 原生助手 | Rust：截图、历史读取与工作区句柄访问辅助程序 |
| 渲染 | Streamdown、Shiki、KaTeX |
| 测试 | Vitest |

## 项目结构

应用从 `src/main/index.ts` 启动，编译入口为 `dist/main/main/index.js`；Preload 提供受控 IPC，React 与 Live2D 负责窗口和桌面展示。

| 路径 | 职责 |
| --- | --- |
| `src/main/` | 主进程服务：编排、记忆、浏览器、渠道、定时、主动聊天、权限与设置 |
| `src/main/orchestrator/` | Agent 编排、工具执行、专业 Agent 与权限集成 |
| `src/main/windows/`、`src/main/plugin-host/` | 窗口、托盘与应用图标；插件在主进程的接线与运行时 |
| `src/main/chat/`、`src/main/chats/`、`src/main/stickers/` | 聊天请求与时间上下文；会话存储与派发；贴纸 |
| `src/preload/`、`src/renderer/` | 受控桥接、React 界面与 Live2D |
| `src/plugins/`、`packages/plugin-sdk/`、`examples/` | 插件宿主、本地 SDK、schema 与示例 |
| `src/shared/` | IPC、数据与事件契约、ZIP 安全解压 |
| `skills/`、`vendor/firefly-skills/` | 项目 Skills 与继承 Skills，附来源、许可与校验 |
| `prompts/`、`assets/` | 分层角色提示词、世界观与产品资源 |
| `native/` | Rust 原生助手：截图、历史读取、工作区句柄访问 |
| `scripts/`、`electron-builder.yml` | 构建、打包、验证脚本与打包配置 |
| `docs/` | 设计、验证与审查记录 |
| `assets/`、`src/renderer/public/`、`readme-assets/` | 应用图标与安装资源；渲染进程静态资源；README 配图与来源记录 |
| `build/`、`resources/` | 安装器脚本；打包前准备的资源（部分由脚本生成或下载） |
| `dist/`、`release/`、`output/` | 编译产物、打包产物、本地报告与开发隔离数据（均不进入 Git） |

## 当前状态与限制

项目在持续开发中。功能入口、自动检查和真实环境验收是分开说明的，这里不引用历史测试数量作为当前结论。

- **需自行准备**：模型服务、知识向量资源、ASR、QQ Music、办公程序、语言服务器和渠道凭据；入口存在不代表对应服务已可用。
- **仍需完整验收**：真实模型端到端、深度 GUI、真实用户环境、麦克风与 ASR、外部办公流程、安装器升级、跨平台兼容。
- **平台**：Windows 是当前主要的开发与验收平台。
- **界面语言**：设置页暂时只有中文；聊天窗口语言选项重启后生效。
- **发布状态**：自动更新保持关闭；当前不承诺公开安装包、本项目的在线插件市场或已发布的 SDK 包。
- **角色素材**：公开再分发所需的授权材料仍需归档，见下方许可说明。

## 参与开发

开发前请阅读 [AGENTS.md](./AGENTS.md) 与 [DEVELOPMENT.md](./DEVELOPMENT.md)，按修改范围运行验证并说明未覆盖项。提交问题或 PR 时不要附上密钥、私人对话或用户数据。

## 许可证与角色素材

源码由 Firefly-0423 以 [MIT License](./LICENSE) 授权；第三方依赖、Skills、模型、图片与角色 IP 分别遵循各自许可或授权。

项目所有者确认取得流萤模型原作者授权；仓库尚未归档可核对的作者署名、授权原文、所涵盖文件与再分发范围，因此不能据此确认公开再分发的具体范围。模型授权不自动覆盖头像、任务肖像、图标、贴图或派生渲染素材，源码 MIT 许可也不授予这些素材的再分发权。详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md) 与 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

流萤及《崩坏：星穹铁道》相关角色形象与知识产权归 HoYoverse / 米哈游及相应权利人所有，本项目为非官方项目。

**非商业使用**：含有流萤角色、Live2D 模型与角色美术的衍生物禁止商业使用（售卖、付费社群、含广告变现、打包销售等）。MIT 许可只约束源码。

顶部徽章由 [Shields.io](https://shields.io) 在浏览时生成，图标来自 Simple Icons（CC0），仓库不保存这些品牌图标；徽章只说明技术栈与平台，不表示实测通过或官方关联，见 [图标说明](./readme-assets/ICON_SOURCES.md)。
