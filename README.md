<p align="center"><b>简体中文</b> · <a href="./README.en.md">English</a></p>

<h1 align="center">Firefly</h1>

<p align="center"><b>与流萤交流，把想法变成可以继续的行动。</b></p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=flat&logo=electron&logoColor=white" alt="Electron" height="22">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript" height="22">
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black" alt="React" height="22">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat&logo=rust&logoColor=white" alt="Rust" height="22">
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white" alt="SQLite" height="22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT 许可证" height="22">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=flat" alt="平台：Windows" height="22">
</p>

<p align="center">以《崩坏：星穹铁道》流萤为角色的 Windows Live2D 桌面伴侣与 AI 工作台。</p>

<p align="center">
  <a href="#-快速开始">快速开始</a> · <a href="#-功能">功能</a> · <a href="#-安全与隐私">安全与隐私</a> · <a href="#-项目结构">项目结构</a> · <a href="#-当前状态与限制">状态与限制</a><br>
  <a href="https://github.com/Firefly-0423/Firefly-Agent/issues">问题反馈</a> · <a href="https://github.com/Firefly-0423/firefly-plugins">插件市场</a>
</p>

---

## ✨ 速览

Firefly 把一个会陪你聊天的桌面角色，和一个能真正动手干活的 Agent 工作台放在同一个窗口里。你可以和流萤闲聊，也可以把文档整理、代码修改、资料检索、日程提醒交给她，并在每一步看到她做了什么、需要你批准什么。

- **有人设，也有边界**：对话遵循流萤的原作设定与说话方式；工具、权限、审批和结果真实性不会因为角色语气而放宽。
- **三种模式，一个入口**：Chat 陪伴、Work 推进任务、Code 处理代码，各自有独立的提示词与工具集。
- **记忆在本地**：个人记忆与历史检索保存在本机 SQLite；是否发往外部服务取决于你选择的模型与工具。
- **默认克制**：写文件、执行命令、联网操作都经过权限等级和审批；浏览器里的手动授权不会变成 Agent 的授权。
- **可扩展**：Skills、插件、MCP 服务和外部渠道都是可选项，按需开启。

| 💬 Chat · 桌面陪伴 | 📋 Work · 推进任务 | 💻 Code · 代码工作区 |
| --- | --- | --- |
| 角色化对话、流式回复与会话历史；Live2D 表情与待机动作。 | 文件、文档与知识资料；调用工具与 Skills，与专业 Agent 协作。 | 在绑定工作区里使用 Git、LSP、AST、文件与命令工具。 |

## 🚀 快速开始

需要 Windows、Node.js 24 与 npm 10 以上；本地打包另需 Rust（MSVC 工具链）与 C++ 构建工具。源码不附带模型、语音资源或账户凭据。

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

隔离根必须是已存在的绝对目录，且不能与正式 appData 目录相同或互为父子目录，否则拒绝启动。要从构建产物启动，在设置了上述变量的同一会话里执行 `npm run build` 与 `npm start`。

第一次打开后：

1. 在设置里创建**模型档案**：填写服务支持的协议、地址、模型和你自己的凭据；OpenRouter 有现成预设。
2. 选择 **Chat / Work / Code**。Work、Code 按任务绑定项目文件夹，也可以在侧栏「项目」旁的「+」里先创建项目。
3. 按需开启工具、Skills、插件或 MCP。涉及写文件、执行命令和外部操作时，会走审批并可以随时取消。

常用检查与打包命令：

| 命令 | 作用 |
| --- | --- |
| `npm run check:renderer` | 界面类型检查 |
| `npm test` | 运行 Vitest |
| `npm run validate:skills` | 校验 Skills 来源与许可 |
| `npm run check:plugin-sdk` | 插件 SDK 检查 |
| `npm run package:win:dir` | 打包为免安装目录 |

脚本说明见 [scripts/README.md](./scripts/README.md)。

## 🧩 功能

### 💬 桌面陪伴与 Chat

- Live2D 流萤：双击互动表情、拖动、待机动作，工具执行时有工作表情。
- 角色化对话、流式回复、会话历史；可开启临时对话，不进入历史。
- 人设来自分层提示词与世界观条目（背景、故事、说话方式、原作台词范例），按话题条件触发，不是每轮都灌入。
- 可选的**主动聊天**：按时段、静默时长和未回复次数克制地开口，你没回应就不会继续打扰。
- 桌面语音输入（ASR）可选关闭、Mossland 或阿里云；转写只填入输入框，不会自动发送。

### 📋 Work：推进任务

- 处理文件、文档与知识资料，调用内置工具与 Skills，并交给专业 Agent 协作；工具执行、审批与取消都可见。
- 内置文件读写与补丁、Word / Excel / PDF 文档工具、网页搜索与正文读取、文件下载、定时任务与日程。
- 已结束的任务可导出为 Markdown；「任务完成」和「文件已完整读取」分开展示。
- **知识工作区**：绑定已有 Obsidian Vault 或学习资料目录，提供学习、测验、笔记和进度。

### 💻 Code：代码工作区

- 在绑定的工作区里阅读和修改代码：Git、LSP、结构化搜索与改写（ast-grep）、文件与命令工具。
- 命令通过受控的 shell 工具运行，带超时与进程树清理；语言服务器需要本机有对应语言环境。
- 右侧面板可打开文件、差异审阅、浏览器与任务面板，并可拖动停靠。

### 🗂️ 侧栏与输入框

- **项目**：侧栏按项目归拢会话；「+」创建项目（命名并选择源文件夹），「…」整理侧边栏与聊天排序，支持置顶、分组、隐藏项目。
- **会话菜单**：重命名、置顶、复制标题或项目路径、用资源管理器或已安装的编辑器打开项目、导出、删除。
- **浮动输入框**：会话中鼠标移到输入框上可以拖动到工作区任意位置或收起成小圆按钮；有审批或提问时会自动展开。

### 🧠 记忆与知识

- 默认记忆链分三层：当前上下文（S）、事实记忆（M）、历史检索（H），由 SQLite 保存。
- 项目里提到的项目信息只在该项目中使用；历史缺少可信快照时如实报告「覆盖不足」。
- 角色与文档知识 RAG（含 BGE-M3）独立配置，不承担默认的个人记忆或历史检索。

### 🔌 网页、扩展与渠道

- **浏览器工作区**：手动浏览与 Agent 操作严格分离；Agent 只能在当前批准的域名与动作范围内使用。
- **Skills**：内置并校验 50 项第三方及适配 Skills 与 4 项项目 Skills，可按模式启用。
- **插件**：本地插件宿主、隔离面板、插件 SDK 与示例；在线目录来自 [firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)，安装时核对 SHA-256，装好后默认停用。
- **MCP**：可添加本机命令启动的服务（stdio），或填写远程地址（Streamable HTTP；以 `/sse` 结尾的地址走旧式 SSE）。
- **渠道**：QQ、QQ Bot、微信、飞书适配，需自行配置凭据。
- **音乐**：可读取 Windows 上 QQ Music 的播放会话。

### 🤖 模型

- 提供 OpenRouter 预设与 Chat Completions 入口；图像输入按「用户声明 → 厂商模型列表 → 内置目录」逐层判定，无法确认时按纯文本处理。
- 具体效果取决于所选模型与服务。

## 🔒 安全与隐私

- **权限等级与审批**：文件与命令按只读、项目只读、受限、完全等等级运行；写入、命令和外部操作遵循审批并可取消。角色、Skills 和头像不会扩大工具权限。
- **命令执行**：Shell 工具有总时长与空闲超时，结束或取消时清理整个进程树。
- **浏览器**：手动授权不授予 Agent 操作权；私有网络目标有单独限制。
- **本地数据**：设置、凭据、历史与用户 Skills 不进入 Git 或安装包。记忆数据库的密钥使用 Windows DPAPI 保护，渠道凭据使用系统加密存储。
- **数据位置**：正式数据默认在 `%APPDATA%\Firefly`，开发实例使用隔离目录；手工处理前请退出应用并备份。
- **外部服务**：根据所选模型与操作，对话、资料、工具结果和录音可能发往外部服务；请只在信任的服务上使用。

## 🛠️ 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行环境 | Node.js 24 + Electron 43 |
| 语言与构建 | TypeScript、Vite 7、electron-builder |
| 界面 | React 19、Ant Design 6 / Ant Design X、Tailwind CSS 4 |
| Live2D | PixiJS 7 + pixi-live2d-display |
| Agent | 自研 Harness 主循环、AG-UI 事件协议、原生工具调用 |
| 工具与代码 | 工具调度与审批、LSP 客户端、`@ast-grep/napi`、`simple-git`、MCP SDK |
| 记忆与检索 | SQLite（`node:sqlite`）、Embedding、BM25、Reranker |
| 原生助手 | Rust：截图、历史读取与工作区句柄访问 |
| 渲染 | Streamdown、Shiki、KaTeX |
| 测试 | Vitest |

## 📦 项目结构

```
src/
├── cli/                  # 命令行入口（firefly 命令、开发启动器）
├── main/                 # Electron 主进程，入口 index.ts → dist/main/main/index.js
│   ├── application/      # 启动装配、依赖注入、IPC 作用域与契约扫描
│   ├── startup/          # 运行档案与数据隔离、身份预检、单实例、启动窗口
│   ├── orchestrator/     # Agent 核心
│   │   ├── harness/      #   Harness 主循环：回合、压缩、重试与不确定性
│   │   ├── tools/        #   工具注册表与内置工具（文件、文档、Git、LSP、ast-grep…）
│   │   ├── vendors/      #   模型厂商适配（结构化输出、函数调用）
│   │   ├── sandbox/      #   Windows 命令执行沙箱
│   │   ├── review/       #   计划审批
│   │   └── structured-output/  # 统一结构化输出管线
│   ├── permission/       # 权限档位、风险判定与审批卡片
│   ├── chat/ chats/      # 聊天请求与 AG-UI 桥接；会话存储、派发与侧栏布局
│   ├── memory*/          # 记忆：核心库、策略、召回、历史读取、来源、影子抽取
│   ├── rag/ knowledge/   # 知识检索；Obsidian / 学习工作区
│   ├── browser/          # 内置浏览器工作区与授权边界
│   ├── code-git/ lsp/    # Code 模式的 Git 服务；语言服务器客户端
│   ├── channels/         # 外部渠道（飞书、微信、QQ、QQ Bot）
│   ├── proactive/        # 主动聊天（时段、策略、投递）
│   ├── scheduler/ tasks/ # 定时任务；任务与子 Agent 会话
│   ├── skills/           # Skills 安装、审查与外部来源
│   ├── plugin-host/ plugin-panel/  # 插件宿主、在线市场；插件面板协议
│   ├── settings/ storage/ logging/ # 设置与凭据；本地存储与路径；日志
│   ├── asr/ audio/ music/ screenshot/  # 语音输入；播放器；QQ Music；截图
│   ├── windows/ toast/ updater/        # 窗口与托盘；通知；应用更新
│   └── ...               # protocols / prompts / services / stickers / social-context 等
├── plugins/              # 插件系统核心（manifest 校验、加载、生命周期）
├── preload/              # 受控 IPC 桥接
├── renderer/             # 渲染进程
│   ├── react/            #   React 界面：聊天、侧栏、设置、组件与样式
│   ├── live2d/           #   Live2D 渲染
│   └── public/           #   静态资源（头像、贴纸、Cubism Core）
└── shared/               # 主进程与渲染进程共享的契约与工具

native/                   # Rust 原生助手：截图、历史读取、工作区句柄访问
plugin-sdk/               # 插件 SDK 源码
examples/                 # 插件示例（text-stats、json-tools、weather-tool 等）
skills/                   # 项目 Skills
vendor/firefly-skills/    # 第三方及适配 Skills，附来源与许可
prompts/                  # 分层角色提示词与世界观
models/                   # 本机 AI 模型（自行放置，见 MODEL_LICENSE.md）
scripts/                  # 构建、打包、验证与评测脚本
docs/                     # 设计、验证与审查记录
assets/ build/ resources/ # 应用图标；安装器脚本；打包前准备的资源
```

> `dist/`、`release/`、`output/` 是编译产物、打包产物和本地报告，不进入 Git。Live2D 模型说明见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)。

## 📌 当前状态与限制

项目在持续开发中，功能入口、自动检查和真实环境验收分开说明。

- **需自行准备**：模型服务、知识向量资源、ASR、QQ Music、办公程序、语言服务器和渠道凭据；入口存在不代表对应服务已可用。
- **仍需完整验收**：真实模型端到端、深度 GUI、麦克风与 ASR、外部办公流程、安装器升级。
- **平台**：Windows 是当前主要的开发与验收平台。
- **界面语言**：设置页暂时只有中文；聊天窗口语言选项重启后生效。
- **发布状态**：自动更新保持关闭，暂未发布公开安装包。

## 🤝 参与开发

开发前请阅读 [AGENTS.md](./AGENTS.md) 与 [DEVELOPMENT.md](./DEVELOPMENT.md)，按修改范围运行验证并说明未覆盖项。插件投稿请到 [firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)。提交问题或 PR 时不要附上密钥、私人对话或用户数据。

## 📄 许可证与角色素材

源码由 Firefly-0423 以 [MIT License](./LICENSE) 授权；第三方依赖、Skills、模型、图片与角色 IP 分别遵循各自许可或授权，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

项目所有者已取得流萤 Live2D 模型原作者的授权，详见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)。模型授权不自动覆盖头像、图标、贴图或派生渲染素材，源码 MIT 许可也不授予这些素材的再分发权。

流萤及《崩坏：星穹铁道》相关角色形象与知识产权归 HoYoverse / 米哈游及相应权利人所有，本项目为非官方、非商业的同人项目。含有流萤角色、Live2D 模型与角色美术的衍生物禁止商业使用。

顶部徽章由 [Shields.io](https://shields.io) 生成，图标来自 Simple Icons（CC0），见 [图标说明](./readme-assets/ICON_SOURCES.md)。
