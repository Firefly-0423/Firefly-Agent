<p align="center"><b>简体中文</b> · <a href="./README.en.md">English</a></p>

<p align="center">
  <img src="./assets/firefly.png" alt="流萤头像" width="160">
</p>

<p align="center">
  <a href="https://github.com/Firefly-0423/Firefly-Agent"><img src="https://img.shields.io/badge/GitHub-Firefly--Agent-24292f?style=flat&logo=github&logoColor=white" alt="GitHub 仓库" height="20"></a>
  <a href="https://github.com/Firefly-0423/Firefly-Agent/releases/latest"><img src="https://img.shields.io/github/v/release/Firefly-0423/Firefly-Agent?style=flat&label=%E4%B8%8B%E8%BD%BD&color=2f8f6b" alt="下载最新版本" height="20"></a>
  <a href="https://hotarufirefly.online"><img src="https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E8%AF%95%E7%94%A8-hotarufirefly.online-5fe0c1?style=flat" alt="在线试用" height="20"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?style=flat&logo=windows&logoColor=white" alt="支持 Windows 10 / 11" height="20">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT 许可证" height="20"></a>
</p>

你是否想过，让流萤住进你的电脑——陪你聊天，也帮你把事情做完？

Firefly-Agent 是以《崩坏：星穹铁道》流萤为角色的 Windows Live2D 桌面伙伴。她既能陪你说话，也能读写文件、改代码、跑命令，还会带上 12 位伙伴分工合作；每一步做了什么、哪里需要你批准，都看得见。

## ✨ 速览

- **三种模式**：Chat 陪你聊天，Work 推进任务，Code 改代码，各有自己的提示词与工具。
- **12 位伙伴**：Work 和 Code 里，流萤把任务拆给擅长的伙伴并行处理，回来后核对、汇总。
- **Live2D 陪伴**：流萤常驻桌面，会随工作状态换表情；也可以开启克制的主动聊天。
- **本地记忆**：记忆与历史检索保存在本机 SQLite，密钥由 Windows DPAPI 保护。
- **先问再动手**：写文件、执行命令、联网操作按权限等级运行，需要你批准，随时可以取消。
- **内置浏览器**：手动浏览与代理浏览分开授权，代理只在你批准的域名和动作范围内操作。
- **多模型接入**：支持 Chat Completions、Anthropic Messages 和 Responses 接口，模型档案自由切换。
- **扩展**：Skills 市场、插件市场与[插件 SDK](./plugin-sdk/)、MCP 服务，以及 QQ、微信、飞书渠道，都按需开启。

## 🚀 快速开始

到 [Releases](https://github.com/Firefly-0423/Firefly-Agent/releases/latest) 下载安装包，需要 Windows 10 / 11（x64）。首次打开后在设置里创建模型档案，填入你自己的模型服务与凭据。想先看看界面，可以去 [hotarufirefly.online](https://hotarufirefly.online) 试用在线演示。

从源码运行需要 Node.js 24 及以上和 pnpm 12.10.1：

```powershell
pnpm install
pnpm exec install-electron
pnpm run dev
```

使用前请阅读[免责声明](./docs/disclaimer.zh-CN.md)；渠道配置见[用户指南](./docs/user-guide/index.md)，打包与原生助手构建见[开发说明](./docs/contributing/development.md)。

## 🗂️ 项目结构

```
src/
├── main/          # Electron 主进程，分七层，每层有自己的 AGENTS.md
│   ├── base/          # 基础：存储、日志、应用身份与数据目录、IPC 注册
│   ├── platform/      # 平台服务：设置、权限与审批、窗口、语音、浏览器、Git、LSP
│   ├── model/         # 模型接入：厂商适配、模型档案、提示词分层
│   ├── tooling/       # 工具契约：注册表、参数校验、执行协调
│   ├── conversation/  # 会话记录：类型、存储与结算
│   ├── knowledge/     # 知识：文档检索、学习工作区、Skills
│   ├── memory/        # 记忆：核心库、召回、历史、上下文
│   ├── agent/         # 智能体运行：主循环、内置工具、MCP、伙伴委派
│   ├── features/      # 功能入口：聊天、会话、渠道、定时任务、插件
│   └── app/           # 组合根：装配各模块，管理启动与退出
├── renderer/      # 渲染进程：React 界面、Live2D、在线演示
├── preload/       # 受控 IPC 桥接
├── plugins/       # 插件系统核心
├── shared/        # 主进程与渲染进程共享的契约
└── cli/           # 命令行入口

native/            # Rust 原生助手：截图、历史读取、工作区句柄
plugin-sdk/        # 插件 SDK；examples/ 是插件示例
skills/            # 项目 Skills；第三方 Skills 在 vendor/firefly-skills/
prompts/           # 分层角色提示词与世界观
site/              # 宣传网站与在线演示
scripts/  docs/    # 构建、打包与验证脚本；设计与开发文档
```

## 💬 反馈与联系

- 问题与建议：[提交 Issue](https://github.com/Firefly-0423/Firefly-Agent/issues)。
- Skills 投稿：[firefly-skills](https://github.com/Firefly-0423/firefly-skills)；插件投稿：[firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)。

提交问题时请不要附上密钥、私人对话或用户数据。

## 📖 关于项目

Firefly-Agent 由 hotaru 开发，首个公开版本 1.1.0 发布于 2026 年 10 月。

- 完整文档见[文档目录](./docs/README.md)，架构与各层职责见 [AGENTS.md](./AGENTS.md)。
- 开发环境、提交前检查和分支规范见[开发说明](./docs/contributing/development.md)。
- 数据默认保存在本机 `%APPDATA%\Firefly-1.2.0`，不进入 Git 或安装包；对话与资料可能发往你选择的模型服务，请只在信任的服务上使用。

## ⚖️ 许可证

- 源码使用 [MIT 许可证](./LICENSE)。
- 第三方依赖、Skills、模型与图片的来源和许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)；Live2D 模型授权见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)。
- 流萤及《崩坏：星穹铁道》相关角色形象与知识产权归 HoYoverse / 米哈游及相应权利人所有。本项目为非官方、非商业的同人项目，含有流萤角色、Live2D 模型与角色美术的衍生物禁止商业使用。

## ⭐ 支持项目

如果喜欢这个项目，欢迎点个 Star 支持一下。
