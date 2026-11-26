<p align="center"><b>简体中文</b> · <a href="./README.en.md">English</a></p>

<p align="center">
  <img src="./assets/firefly.png" alt="流萤头像" width="160">
</p>

<p align="center">
  <a href="https://github.com/Firefly-0423/Firefly-Agent"><img src="https://img.shields.io/badge/GitHub-Firefly--Agent-24292f?style=flat&logo=github&logoColor=white" alt="GitHub 仓库" height="20"></a>
  <a href="https://gitcode.com/hotaru_wu/Firefly-Agent"><img src="https://img.shields.io/badge/GitCode-Firefly--Agent-d94336?style=flat" alt="GitCode 仓库" height="20"></a>
</p>

Firefly-Agent 是以《崩坏：星穹铁道》流萤为角色的 Windows 桌面伙伴，陪你聊天，也能在电脑上帮你完成任务。

## 能做什么

- **三种模式**：Chat 陪你日常聊天，Work 帮你处理文档和日常任务，Code 用来看代码、改代码和跑命令。
- **伙伴协作**：遇到复杂任务时，流萤会把合适的工作分给 12 位伙伴并行处理，完成后统一核对结果。
- **Live2D 陪伴**：流萤会常驻桌面，随着工作进度切换表情，也能按你设定的节奏主动搭话。
- **本地记忆**：聊天记录与长期记忆保存在你自己的电脑上，模型密钥与凭据由系统安全机制加密保管。
- **先问再动手**：文件访问提供“只读 / 请求审批 / 完全访问”三档权限，高风险操作先弹出审批，运行时也能随时取消。
- **内置浏览器**：支持手动浏览，也可以授权流萤代理操作；切到别的会话后页面仍保留，只读观察不会打断你。
- **多模型支持**：接入兼容的对话与响应接口，可以在多个模型档案之间随时切换。
- **插件与扩展**：支持离线与本地插件、Skills、MCP 工具以及定时提醒；外部渠道界面将在 1.2.x 完善。

## 下载与安装

- **系统要求**：Windows 10 / 11（64 位）。
- **下载安装包**：前往 [GitHub Releases](https://github.com/Firefly-0423/Firefly-Agent/releases/latest) 获取最新安装程序。
- **在线体验**：想先看界面，可以直接访问 [hotarufirefly.online](https://hotarufirefly.online)。
- **首次配置**：安装并打开后，前往设置页添加至少一个模型档案，填入你自己的模型服务地址与密钥即可开始使用。
- **独立数据目录**：1.2.0 将对话、设置和日志保存在独立的 `%APPDATA%\Firefly-1.2.0` 目录，不会读取、修改或迁移 1.1.x 的旧数据。

使用前请先阅读[免责声明](./docs/disclaimer.zh-CN.md)；如需配置外部聊天渠道或排查数据目录问题，可查看[用户指南](./docs/user-guide/index.md)。

## 1.2.0 新变化与已知限制

### 主要变化

- **全新深色主题**：深色模式改用中性近黑背景搭配翡翠绿强调色，统一聊天页、设置页与提示窗口的明暗层次。
- **全新的插件系统**：插件运行在独立进程中，支持本地导入、启用前能力与信任确认、逐项撤权、模型限频以及隔离的插件窗口；不再兼容 0.x 旧插件。
- **插件定时任务确认**：插件提出的定时任务会进入待确认列表，由你核对后再启用，支持带时区的定时表达式和任务面板“立即运行”。
- **更稳的任务体验**：Work 与 Code 任务支持切换会话或刷新后继续在后台完成、从提醒小窗直接处理审批，并在运行途中点击“立即补充”插入新要求。
- **权限更清晰**：收口为“只读 / 请求审批 / 完全访问”三档。

完整版本变更请查看 [GitHub Releases](https://github.com/Firefly-0423/Firefly-Agent/releases) 页面或发布分支上的 `CHANGELOG.md`。

### 已知限制

- **1.2.0 暂不支持无人值守运行审批**：插件定时任务如果会用到命令行、写文件或控制键鼠等高风险工具，在确认时会被直接拒绝并提示暂不支持；此前已确认的同类任务到点会跳过并暂停周期计划。无人值守运行审批入口计划在 1.2.x 补齐。
- **外部渠道桌面接入待 1.2.x**：1.2.0 的新插件系统已具备渠道运行基础，桌面端的统一渠道配置界面将在 1.2.x 提供。

## 插件开发

如果想为 Firefly 编写 1.2.0 插件，可以从以下文档开始：

- [插件 SDK 说明](./plugin-sdk/README.md)：安装方式、最小插件结构、权限模型与本地测试宿主。
- [插件开发指南](./docs/plugins/plugin-dev-guide.md)：清单字段、插件接口说明与完整示例。
- [插件作者须知](./docs/plugins/plugin-authoring.md)：隔离边界、权限分级与上架要求。

仓库里的 [plugin-sdk/examples](./plugin-sdk/examples/) 也提供了天气查询和每日提醒两个可直接参考的示例插件。

## 参与开发

从源码运行需要 **Windows**、**Node.js 24+** 和 **pnpm 12.10.1**。

```powershell
pnpm install --frozen-lockfile
pnpm exec install-electron
pnpm run dev
```

更多环境准备、打包命令与提交前规范见[开发说明](./docs/contributing/development.md)和[协作流程](./docs/contributing/development-workflow.md)；全仓文档索引在[文档目录](./docs/README.md)。

## 反馈与联系

- 使用问题与功能建议：前往 [GitHub Issues](https://github.com/Firefly-0423/Firefly-Agent/issues) 提交反馈。
- Skills 投稿与维护：[firefly-skills](https://github.com/Firefly-0423/firefly-skills)。
- 插件目录与投稿：[firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)。

提交反馈前，请务必移除个人密钥、对话原文以及本机路径等敏感信息。

## 许可证与致谢

- 源码采用 [MIT 许可证](./LICENSE) 开源。
- 第三方依赖、内置 Skills 与历史组件声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
- 桌面内置的「Firefly 流萤前瞻小人桌宠」Live2D 模型由作者**是依七哒**授权 Firefly 使用，其他自绘形象与角色 IP 的授权边界见 [MODEL_LICENSE.md](./MODEL_LICENSE.md)。
- 流萤及《崩坏：星穹铁道》相关角色形象与知识产权归 HoYoverse / 米哈游及相应权利人所有；本项目为非官方、非商业同人作品，含角色形象或模型的衍生内容禁止商业使用。
