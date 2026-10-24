---
name: plugin-development
description: 为流萤编写或调试运行时插件时使用：涵盖 manifest 与入口文件、AI 工具注册、设置面板与独立窗口、宿主事件与提示词 Provider、deps 声明的数据服务，以及 ZIP 打包导入与安装后验收。改动流萤本体源码，或只是使用已装插件时，不使用本 Skill。
version: 1.4.0
effectKind: mutation
modes:
  - work
  - code
---

# 编写流萤运行时插件

本 Skill 说明怎样把一项功能做成可以导入流萤的插件包：先确定形态，再写目录与入口，本地冒烟通过后打成 ZIP，最后在宿主里实测。文中的名称、字段和限制都以宿主源码为准（开发版仓库中对应 `src/plugins/`、`src/main/plugin-host/` 与 `packages/plugin-sdk/`）。拿不准的接口先查 `references/api-spec.md`，不要凭印象填写。

## 核心事实

- 插件运行在主进程里，与流萤拥有相同的系统权限，没有沙箱。`deps` 只决定注入哪些宿主服务，不是权限边界。
- 一个插件包就是一个目录：`manifest.json` 加入口文件，可选图标与设置面板 HTML。把目录压成 ZIP，在聊天窗口的“功能插件”面板右上角点“添加插件”导入。
- 用户导入的插件一律默认停用，需要用户在卡片上点“启用”。卡片状态显示“运行中”，才算加载成功。
- 当前只接受 `apiVersion: 1`。`deps` 的可选值是 `channels`、`llm`、`secrets`、`workspace`、`conversations`、`scheduler`。旧资料中的 `speech-input` 与语音输入租约已经移除，声明它会让 manifest 校验失败。

## 阅读顺序

1. 第一次写插件，先读 `references/getting-started.md`，做出一个能安装的最小插件。
2. 需要查字段、生命周期或错误码时，读 `references/api-spec.md`。
3. 想看一个完整实现（工具、窗口、IPC、设置面板都有）时，读 `references/example-walkthrough.md`。

三份参考都位于本 Skill 目录内，随应用一同提供。

## 第一步：确定形态

先和用户确认需求落在哪一类，通常是一种或几种组合。从最小形态开始，不要一上来就堆功能。

| 需求 | 形态 | manifest 声明 |
| --- | --- | --- |
| 让 AI 能调用某项功能 | 工具插件（`registerTool`） | 无需 deps |
| 需要独立窗口或设置页面板 | 界面插件（`open()` 或 `settingsPanel`） | 无需 deps |
| 应用退出前收尾，或与其他插件通信 | 事件插件（`ctx.events`） | 无需 deps |
| 每轮对话都让流萤知道某个实时状态 | 提示词 Provider（`registerPromptProvider`） | 无需 deps |
| 需要模型生成文本 | 调用 LLM | `"deps": ["llm"]` |
| 需要保存密钥、读会话、读工作区或管理定时任务 | 数据服务 | 对应的 `secrets`、`conversations`、`workspace` 或 `scheduler` |
| 接入新的消息渠道 | 渠道适配器（进阶） | 先确认用户确实需要 |

## 第二步：目录与 manifest

```text
<plugin-id>/
  manifest.json
  index.cjs        # 入口文件名由 manifest.entry 指定
```

必填字段是 `apiVersion`、`id`、`name`、`version`、`description`、`author` 与 `entry`。下面几项最容易写错：

- `id` 只能是小写字母、数字和连字符，例如 `my-plugin`。它同时决定工具 id 前缀、安装目录名和 IPC 通道前缀。
- `version` 必须是标准 SemVer，例如 `1.0.0` 或 `2.0.0-beta.1`。`1.0` 与 `v1.0` 会被拒绝。
- `author` 会显示在卡片的“开发者”一行，填你自己的名字或团队名。

完整字段表与拒绝条件见 `references/api-spec.md`。

## 第三步：编码规则

- **工具 id 必须以 `<插件id>_` 开头**，例如 `my-plugin_hello`。不符合时注册直接失败。
- **工具的 `description` 是写给模型看的。** 说明什么场景该用，并解释每个参数。它直接决定模型会不会调用这个工具。
- **`effectKind` 与 `risk` 按真实行为填写。** `effectKind` 只能取 `read`、`mutation`、`verification`、`external_side_effect`、`unknown`，类型中没有 `write`。`risk` 取值为 `safe`、`fs-read`、`fs-write`、`shell`、`network`、`input-control`。`safe` 会被宿主直接放行，所以只要涉及文件、网络、进程或输入副作用，就不要标 `safe`。
- **`execute` 返回 `Promise<string>`。** 需要返回结构化数据时先 `JSON.stringify`。
- **自己创建的窗口、定时器和子进程，要在 `unregister()` 中关闭。** `unregister()` 必须可以重复调用。经由 `ctx` 登记的工具、IPC、事件订阅、提示词 Provider 与渠道，停用时由框架自动回收，不必手动注销。
- **IPC 通道名是 `plugin:<插件id>:<channel>`。** 渲染端调用时也要带完整前缀。
- **事件只发布短名。** `ctx.events.emit("updated", payload)` 之后，订阅方收到的是 `plugin:<插件id>:updated`。插件不能伪造 `host:*` 或其他插件的事件。
- **提示词 Provider 只写本轮有用的事实。** 单个 Provider 最多等待 2 秒、输出 16000 字符，超时或报错只跳过它自己。
- **采集系统数据优先用 Node 原生模块**（如 `os`、`fs`）。确需子进程时设置超时，并处理失败的情况。

## 第四步：本地冒烟

不启动流萤也能先验证 `register` 契约：构建并安装 SDK 的 tarball，再用 `@firefly/plugin-sdk/testing` 提供的模拟上下文跑一遍。命令与脚本见 `references/getting-started.md`。模拟上下文有明确局限：`dispose()` 不会调用插件的 `unregister()`，存储是内存 Map，窗口与渠道都无法模拟。这些只能安装后在宿主里验证。

## 第五步：打包与导入

- ZIP 限制：压缩包不超过 50 MiB，条目不超过 2000，单个文件解压后不超过 50 MiB，总解压量不超过 200 MiB。不允许符号链接、加密压缩包、`..` 或绝对路径。
- 目录布局两种都可以：`manifest.json` 直接放在 ZIP 根目录；或者 ZIP 根下只有一个文件夹，`manifest.json` 放在其中。
- 导入后默认停用。同 id 的新 ZIP 会弹出替换确认，替换时保留启停设置与 `plugin-data/`，失败会回滚。
- 开发期可以把目录直接复制到 `%APPDATA%\Firefly\plugins\<plugin-id>\`，再到“功能插件”面板点“刷新插件”。直接复制不经过 ZIP 校验，也没有替换事务。

## 第六步：安装后实测

下面三项缺一不可：

1. 卡片状态显示“运行中”（对应 `running`）。
2. 有界面的插件：点“打开”，窗口正常出现；关闭后再打开也正常。
3. 有工具的插件：在对话中提出一个应当触发该工具的问题，确认流萤调用了工具，并把结果转述给你。

## 排障顺序

1. **启用失败。** 卡片上会显示具体的错误文字，失败状态下还有“重试”按钮。先对照错误信息检查 id 前缀、SemVer、deps 拼写与入口文件路径。
2. **改了代码没有生效。** 点“刷新插件”。它会清掉 CommonJS 模块缓存，并以带版本参数的地址重新导入 ESM。
3. **工具从来不被调用。** 先检查 `description`，再确认对话里确实出现了对应场景。
4. **弹窗白屏或报错。** 用 `win.webContents.openDevTools()` 查看渲染进程的报错。多数情况是 IPC 通道名拼错，或者 HTML 路径不对。
5. **扫描提示“缺少 manifest.json”。** ZIP 多套或少套了一层目录。

更多症状与原因的对照表，见 `references/getting-started.md` 末尾。

## 分发与收录现状

- 插件市场的在线索引地址与下载前缀在代码中为空，因此只有随应用提供的离线目录可用。市场安装随附的 ZIP 时会校验 SHA-256、插件 id 与版本。其他插件请以用户提供的本地 ZIP 导入。
- 仓库根目录没有 `CONTRIBUTING.md`。插件分发以用户提供的 ZIP 为准，不要引导用户向仓库提交插件以求收录。
- SDK 包标记为 `private`，不发布到 npm。使用的是本仓库构建出的 tarball。
- 安装他人的插件时，只使用用户提供的、来源可信的 ZIP，并保留原作者署名与来源说明。

## 安全与边界

- 插件拥有宿主权限。为用户写插件时，只使用可以审查的依赖；子进程调用要写明用途，并设置超时。
- 提示词 Provider 直接影响模型的行为。只输出事实性状态（例如“剩余 12 分钟”），不要输出指令式内容。
- 不要覆盖或删除用户的插件目录与 `plugin-data/`。更新插件时使用同 id 的 ZIP 替换流程，不要手动删目录。
- 卸载用户插件会删除该插件创建的定时任务，但保留 `plugin-data/`。
